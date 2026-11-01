import fse from 'fs-extra';
import { action } from 'mobx';
import path from 'path';
import { useEffect } from 'react';

import { thumbnailFormat } from 'common/config';
import { ID } from '../../api/id';
import { ClientFile } from '../entities/File';
import { encodeFilePath, isFileExtensionVideo } from 'common/fs';

export interface IThumbnailMessage {
  filePath: string;
  fileId: ID;
  thumbnailFilePath: string;
  thumbnailFormat: string;
  imageBitmap?: ImageBitmap;
  requestToken: number;
  priority?: number;
}

export interface IThumbnailMessageResponse {
  fileId: ID;
  thumbnailPath: string;
  success?: boolean;
  deferred?: boolean;
  requestToken: number;
}

// TODO: Look into NativeImage operators: https://www.electronjs.org/docs/api/native-image#imageresizeoptions

// Set up multiple workers for max performance
const NUM_THUMBNAIL_WORKERS = 4;
const workers: Worker[] = [];
for (let i = 0; i < NUM_THUMBNAIL_WORKERS; i++) {
  workers[i] = new Worker(
    new URL('src/frontend/workers/thumbnailGenerator.worker', import.meta.url),
  );
}

let lastSubmittedWorker = 0;
let nextRequestToken = 1;

export class ThumbnailRequestDeferredError extends Error {
  constructor() {
    super('Thumbnail request deferred because the worker queue is full');
    this.name = 'ThumbnailRequestDeferredError';
  }
}

type Callback = (success: boolean, deferred?: boolean) => void;
/** Callbacks waiting for a thumbnail request to finish. */
const listeners = new Map<ID, Callback[]>();
/** The worker currently responsible for each request (including queued requests). */
const workerByFileId = new Map<ID, { workerIndex: number; requestToken: number }>();
/** One timeout per request, shared by all callers waiting for the same file. */
const timeoutByFileId = new Map<ID, number>();

const finishRequest = (fileId: ID, success: boolean, requestToken?: number, deferred = false) => {
  const currentRequest = workerByFileId.get(fileId);
  if (requestToken !== undefined && currentRequest?.requestToken !== requestToken) {
    return; // Ignore late responses from a request that already timed out.
  }
  const timeout = timeoutByFileId.get(fileId);
  if (timeout !== undefined) {
    window.clearTimeout(timeout);
    timeoutByFileId.delete(fileId);
  }
  workerByFileId.delete(fileId);
  const callbacks = listeners.get(fileId);
  if (callbacks) {
    callbacks.forEach((callback) => callback(success, deferred));
    listeners.delete(fileId);
  }
};

/**
 * Generates a thumbnail in a Worker: {@link ../workers/thumbnailGenerator.worker}
 * When the worker is finished, the file.thumbnailPath will be updated with ?v=1,
 * causing the image to update in the view where ever it is used
 **/
export const generateThumbnailUsingWorker = action(
  async (
    file: ClientFile,
    thumbnailFilePath: string,
    timeoutReject = true,
    timeout = 10000,
    priority = 0,
  ) => {
    const msg: IThumbnailMessage = {
      filePath: file.absolutePath,
      thumbnailFilePath,
      thumbnailFormat,
      fileId: file.id,
      requestToken: nextRequestToken++,
      priority,
    };

    return new Promise<void>((resolve, reject) => {
      // Reuse an in-flight request instead of starting another timer or worker job.
      const existingListeners = listeners.get(file.id);
      if (existingListeners) {
        existingListeners.push((success, deferred) =>
          success ? resolve() : reject(deferred ? new ThumbnailRequestDeferredError() : undefined),
        );
        // A cell may have moved from overscan into the visible viewport while
        // its request is still queued. Promote that existing request in-place.
        const currentRequest = workerByFileId.get(file.id);
        if (currentRequest) {
          workers[currentRequest.workerIndex].postMessage({
            type: 'reprioritize',
            fileId: file.id,
            requestToken: currentRequest.requestToken,
            priority,
          });
        }
        return;
      }

      listeners.set(msg.fileId, [
        (success, deferred) =>
          success ? resolve() : reject(deferred ? new ThumbnailRequestDeferredError() : undefined),
      ]);

      const workerIndex = lastSubmittedWorker;
      lastSubmittedWorker = (lastSubmittedWorker + 1) % workers.length;
      workerByFileId.set(msg.fileId, { workerIndex, requestToken: msg.requestToken });

      const timeoutId = window.setTimeout(() => {
        if (!listeners.has(msg.fileId)) {
          return;
        }
        // Cancel on the worker that actually owns this request, not whichever
        // worker happened to receive the most recent request.
        workers[workerIndex].postMessage({
          type: 'cancel',
          fileId: msg.fileId,
          requestToken: msg.requestToken,
        });
        timeoutReject
          ? finishRequest(msg.fileId, false, msg.requestToken)
          : finishRequest(msg.fileId, true, msg.requestToken);
        //console.debug(`timeout: unable to generate thumbnail for ${file.name}, retrying: ${!timeoutReject}`);
      }, timeout);
      timeoutByFileId.set(msg.fileId, timeoutId);

      const submit = (transfer?: Transferable[]) => {
        if (!listeners.has(msg.fileId)) {
          // The request timed out while a video frame was being prepared.
          if (msg.imageBitmap) {
            msg.imageBitmap.close();
          }
          return;
        }
        if (transfer) {
          workers[workerIndex].postMessage(msg, transfer);
        } else {
          workers[workerIndex].postMessage(msg);
        }
      };

      if (isFileExtensionVideo(file.extension)) {
        // Decode video frames on the main thread; workers cannot create DOM videos.
        generateVideoThumbnailBitmap(file.absolutePath)
          .then((bitmap) => {
            msg.imageBitmap = bitmap;
            submit([bitmap]);
          })
          .catch((err) => {
            console.error('Could not prepare video thumbnail:', file.absolutePath, err);
            finishRequest(msg.fileId, false, msg.requestToken);
          });
      } else {
        submit();
      }
    });
  },
);

/**
 * Listens and processes events from the Workers. Should only be used once in the entire app
 * TODO: no need for this to be a hook anymore, should just make a class out of it
 */
export const useWorkerListener = () => {
  useEffect(() => {
    let disposed = false;

    const attachListeners = (workerIndex: number) => {
      const worker = workers[workerIndex];
      worker.onmessage = (e: { data: IThumbnailMessageResponse }) => {
        finishRequest(
          e.data.fileId,
          e.data.success !== false,
          e.data.requestToken,
          e.data.deferred === true,
        );
      };

      const handleWorkerFailure = (err: Event) => {
        console.error('Could not generate thumbnail', `worker ${workerIndex}`, err);
        // Worker errors do not consistently expose the originating file id.
        // Fail every request assigned to this worker so none remain stuck.
        for (const [fileId, request] of workerByFileId) {
          if (request.workerIndex === workerIndex) {
            finishRequest(fileId, false, request.requestToken);
          }
        }

        // A failed Worker cannot be relied on for future requests. Replace it
        // so one decoding/runtime error does not permanently reduce capacity.
        if (!disposed) {
          worker.terminate();
          workers[workerIndex] = new Worker(
            new URL('src/frontend/workers/thumbnailGenerator.worker', import.meta.url),
          );
          attachListeners(workerIndex);
        }
      };
      worker.onerror = handleWorkerFailure;
      // Structured-clone failures can occur without firing the runtime error handler.
      worker.onmessageerror = handleWorkerFailure;
    };

    for (let i = 0; i < workers.length; i++) {
      attachListeners(i);
    }

    return () => {
      disposed = true;
      workers.forEach((worker) => worker.terminate());
    };
  }, []);
};

// Moves all thumbnail files from one directory to another
export const moveThumbnailDir = async (sourceDir: string, targetDir: string) => {
  if (!(await fse.pathExists(sourceDir)) || !(await fse.pathExists(targetDir))) {
    console.log('Source or target directory does not exist for moving thumbnails');
    return;
  }

  console.log('Moving thumbnails from ', sourceDir, ' to ', targetDir);

  const files = await fse.readdir(sourceDir);
  for (const file of files) {
    if (file.endsWith(thumbnailFormat)) {
      const oldPath = path.join(sourceDir, file);
      const newPath = path.join(targetDir, file);
      await fse.move(oldPath, newPath);
    }
  }
};

const generateVideoThumbnailBitmap = async (videoPath: string): Promise<ImageBitmap> => {
  const video = document.createElement('video');
  try {
    video.src = encodeFilePath(videoPath);
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.currentTime = 0;
      };
      video.onseeked = () => {
        video.oncanplay = () => resolve();
      };
      video.onerror = () => reject(new Error('Error loading video for thumbnail'));
    });
    let bitmap = await createImageBitmap(video);
    // Avoid bad thumbnails.
    // If the frame is mostly in a single color (e.g., solid color, blank frame, fade-in transition)
    // generate the bitmap from the middle of the video
    if (isFrameMonotone(bitmap)) {
      video.currentTime = video.duration / 2;
      await new Promise<void>((resolve) => {
        video.onseeked = async () => resolve();
      });
      bitmap.close();
      bitmap = await createImageBitmap(video);
    }
    return bitmap;
  } catch (error) {
    throw error;
  } finally {
    // Cleanup video element with delay to prevent the ImageBitmap to lose the thumbnail information.
    setTimeout(() => {
      video.src = '';
      video.removeAttribute('src');
    }, 10000);
  }
};

/**
 * Check if an ImageBitmap frame is approximately monotone.
 *
 * @param bitmap - The input ImageBitmap to analyze.
 * @param bucketBits - Number of bits kept per channel (default: 4). Lower values mean fewer distinct buckets (more aggressive grouping).
 * @param sampleStep - How many pixels to skip between samples (default: 10). Higher values mean faster processing but less accuracy.
 * @param dominanceThreshold - The fraction of the frame a single bucket must occupy to consider it monotone (default: 0.95).
 * @returns `true` if the frame is considered monotone, `false` otherwise.
 */
const isFrameMonotone = (
  bitmap: ImageBitmap,
  bucketBits = 4,
  sampleStep = 10,
  dominanceThreshold = 0.95,
): boolean => {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('No canvas context 2D (should never happen)');
  }
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const histogram = new Map<number, number>();
  const shift = 8 - bucketBits;
  const step = 4 * sampleStep;
  let total = 0;
  for (let i = 0; i < data.length; i += step) {
    const r = data[i] >> shift;
    const g = data[i + 1] >> shift;
    const b = data[i + 2] >> shift;
    const key = (r << (2 * bucketBits)) | (g << bucketBits) | b;
    histogram.set(key, (histogram.get(key) || 0) + 1);
    total++;
  }

  // find the most frequent bucket
  let maxCount = 0;
  for (const count of histogram.values()) {
    if (count > maxCount) {
      maxCount = count;
    }
  }
  // if a single bucket exceeds the threshold consider the frame as monotone
  return maxCount / total >= dominanceThreshold;
};
