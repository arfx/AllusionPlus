import fse from 'fs-extra';

import { thumbnailFormat, thumbnailMaxSize } from 'common/config';
import { IThumbnailMessage, IThumbnailMessageResponse } from '../image/ThumbnailGeneration';

// TODO: Merge this with the generateThumbnail func from frontend/image/utils.ts, it's duplicate code
const generateThumbnailData = async (
  filePath: string,
  imageBitmap?: ImageBitmap,
): Promise<ArrayBuffer | null> => {
  let inputBuffer = null;
  let inputBlob = null;
  let img = null;
  let canvas = null;
  let ctx2D = null;
  let thumbBlob = null;
  let buffer = null;

  try {
    if (imageBitmap !== undefined) {
      img = imageBitmap;
    } else {
      inputBuffer = await fse.readFile(filePath);
      inputBlob = new Blob([inputBuffer]);
      img = await createImageBitmap(inputBlob);
    }

    // Scale the image so that either width or height becomes `thumbnailMaxSize`
    let width = img.width;
    let height = img.height;
    const isLowRes = !(width > thumbnailMaxSize || height > thumbnailMaxSize);
    if (!isLowRes) {
      if (img.width >= img.height) {
        width = thumbnailMaxSize;
        height = (thumbnailMaxSize * img.height) / img.width;
      } else {
        height = thumbnailMaxSize;
        width = (thumbnailMaxSize * img.width) / img.height;
      }
    }

    canvas = new OffscreenCanvas(width, height);

    ctx2D = canvas.getContext('2d');
    if (!ctx2D) {
      console.warn('No canvas context 2D (should never happen)');
      return null;
    }

    // Todo: Take into account rotation. Can be found with https://www.npmjs.com/package/node-exiftool

    // TODO: Could maybe use https://www.electronjs.org/docs/api/native-image#imageresizeoptions

    ctx2D.imageSmoothingEnabled = !isLowRes;
    ctx2D.imageSmoothingQuality = !isLowRes ? 'high' : 'low';
    ctx2D.drawImage(img, 0, 0, width, height);

    thumbBlob = await canvas.convertToBlob({
      type: `image/${thumbnailFormat}`,
      quality: isLowRes ? 1 : 0.75,
    });
    // TODO: is canvas.toDataURL faster?
    const reader = new FileReaderSync();
    buffer = reader.readAsArrayBuffer(thumbBlob);
    return buffer;
  } catch (error) {
    console.error('Error generating thumbnail data:', error);
    return null;
  } finally {
    // Explicit Memory Deallocation
    if (img) {
      try {
        img.close();
      } catch (e) {
        console.warn('Failed to close ImageBitmap:', e);
      }
    }

    inputBuffer = null;
    inputBlob = null;
    canvas = null;
    ctx2D = null;
    thumbBlob = null;
  }
};

const generateAndStoreThumbnail = async (
  filePath: string,
  thumbnailFilePath: string,
  imageBitmap?: ImageBitmap,
) => {
  let thumbnailData = await generateThumbnailData(filePath, imageBitmap);
  if (thumbnailData) {
    await fse.outputFile(thumbnailFilePath, Buffer.from(thumbnailData));
    return thumbnailFilePath;
  }
  thumbnailData = null;
  return '';
};

// The worker context
const ctx: Worker = self as any;

// Set up a queue of thumbnails that need to be processed
// Without a queue, I've had to restart my computer since everything froze
// (not 100% sure whether that was the cause)
// Keep speculative work bounded so rapid scrolling does not build an ever-growing backlog.
// Visible requests may exceed this soft limit rather than being discarded.
const queue: IThumbnailMessage[] = [];
const MAX_PARALLEL_THUMBNAILS = 4; // Related to amount of workers. Currently 4 workers with 4 thumbs in parallel = 16 thumbs parallel total
const MAX_QUEUE_LENGTH = 8;
let curParallelThumbnails = 0;

const releaseImageBitmap = (data: IThumbnailMessage) => {
  // Video frames are transferred to the worker before queue admission. If a queued
  // request is discarded or cancelled, no generation path will close its bitmap.
  data.imageBitmap?.close();
};

const reportDroppedRequest = (dropped: IThumbnailMessage) => {
  releaseImageBitmap(dropped);
  // Resolve the main-thread promise immediately rather than waiting for timeout.
  ctx.postMessage({
    fileId: dropped.fileId,
    thumbnailPath: dropped.filePath,
    success: false,
    deferred: true,
    requestToken: dropped.requestToken,
  } satisfies IThumbnailMessageResponse);
  console.debug(`Queue full (${MAX_QUEUE_LENGTH}). Dropped request for ${dropped.filePath}.`);
};

const insertIntoQueue = (data: IThumbnailMessage) => {
  const priority = data.priority ?? 0;
  let insertAt = queue.findIndex((item) => (item.priority ?? 0) < priority);
  if (insertAt === -1) {
    insertAt = queue.length;
  }
  queue.splice(insertAt, 0, data);
};

const addToQueue = (data: IThumbnailMessage) => {
  if (queue.length >= MAX_QUEUE_LENGTH) {
    // Keep higher-priority visible thumbnails and discard speculative work first.
    let lowestIndex = 0;
    for (let i = 1; i < queue.length; i++) {
      if ((queue[i].priority ?? 0) < (queue[lowestIndex].priority ?? 0)) {
        lowestIndex = i;
      }
    }

    const incomingPriority = data.priority ?? 0;
    const lowestPriority = queue[lowestIndex].priority ?? 0;

    if (incomingPriority < lowestPriority) {
      reportDroppedRequest(data);
      return;
    }

    if (incomingPriority === lowestPriority) {
      // Priority 3 is currently visible in the viewport. Never defer visible
      // work just because the queue is busy; the renderer bounds mounted cells.
      // Speculative requests (priority 0-2) can be dropped to favor newer work.
      if (incomingPriority >= 3) {
        insertIntoQueue(data);
      } else {
        reportDroppedRequest(data);
      }
      return;
    }

    const evicted = queue.splice(lowestIndex, 1)[0];
    reportDroppedRequest(evicted);
  }

  insertIntoQueue(data);
};

async function processMessage(data: IThumbnailMessage) {
  const { filePath, thumbnailFilePath, fileId, imageBitmap } = data;
  try {
    // console.log('Processing thumbnail message', { data, curParallelThumbnails, queue });
    if (curParallelThumbnails < MAX_PARALLEL_THUMBNAILS) {
      curParallelThumbnails++;
      const thumbnailPath = await generateAndStoreThumbnail(
        filePath,
        thumbnailFilePath,
        imageBitmap,
      );
      const response: IThumbnailMessageResponse = {
        fileId,
        thumbnailPath: thumbnailPath || filePath,
        success: Boolean(thumbnailPath),
        requestToken: data.requestToken,
      };
      ctx.postMessage(response);
      curParallelThumbnails--;
    } else {
      addToQueue(data);
    }
  } catch (err) {
    curParallelThumbnails--;
    console.error('Could not generate image thumbnail', data.filePath, err);
    // If an error occurs, just load the real file
    ctx.postMessage({ fileId, thumbnailPath: filePath, success: false, requestToken: data.requestToken });
  }
  if (curParallelThumbnails < MAX_PARALLEL_THUMBNAILS && queue.length > 0) {
    processMessage(queue.shift()!); // "pop" from the queue. First elements are at the start, so shift em
  }
}

// Respond to message from parent thread
ctx.addEventListener('message', async (event) => {
  // Promote a queued request when its cell moves into the visible viewport.
  if (event.data.type === 'reprioritize') {
    const index = queue.findIndex(
      (item) =>
        item.fileId === event.data.fileId && item.requestToken === event.data.requestToken,
    );
    if (index !== -1) {
      const [item] = queue.splice(index, 1);
      item.priority = Math.max(item.priority ?? 0, event.data.priority ?? 0);
      insertIntoQueue(item);
    }
    return;
  }

  // Remove the image from the queue when timeout occurs
  if (event.data.type === 'cancel') {
    const index = queue.findIndex(
      (item) =>
        item.fileId === event.data.fileId && item.requestToken === event.data.requestToken,
    );
    if (index !== -1) {
      const [cancelled] = queue.splice(index, 1);
      releaseImageBitmap(cancelled);
      console.debug(`Cancelled request for fileId: ${event.data.fileId}`);
    }
    return;
  }
  await processMessage(event.data);
});
