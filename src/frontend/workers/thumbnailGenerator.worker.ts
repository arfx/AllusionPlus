import fse from 'fs-extra';

import { thumbnailFormat, thumbnailMaxSize } from 'common/config';
import { IThumbnailMessage, IThumbnailMessageResponse } from '../image/ThumbnailGeneration';

// TODO: Merge this with the generateThumbnail func from frontend/image/utils.ts, it's duplicate code
const QUICK_PREVIEW_MAX_SIZE = 128;

const renderImageBuffer = async (
  img: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<ArrayBuffer> => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context 2D');
  context.imageSmoothingEnabled = width < img.width || height < img.height;
  context.imageSmoothingQuality = 'high';
  context.drawImage(img, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: `image/${thumbnailFormat}`, quality });
  return blob.arrayBuffer();
};

const generateThumbnailData = async (
  filePath: string,
  imageBitmap?: ImageBitmap,
): Promise<{ preview: ArrayBuffer | null; thumbnail: ArrayBuffer | null }> => {
  let inputBuffer: Buffer | null = null;
  let inputBlob: Blob | null = null;
  let img: ImageBitmap | null = null;
  try {
    if (imageBitmap !== undefined) img = imageBitmap;
    else {
      inputBuffer = await fse.readFile(filePath);
      inputBlob = new Blob([inputBuffer]);
      img = await createImageBitmap(inputBlob);
    }
    const maxEdge = Math.max(img.width, img.height);
    const scaleTo = (maxSize: number) => {
      const scale = Math.min(1, maxSize / maxEdge);
      return {
        width: Math.max(1, Math.round(img!.width * scale)),
        height: Math.max(1, Math.round(img!.height * scale)),
      };
    };
    const previewSize = scaleTo(QUICK_PREVIEW_MAX_SIZE);
    const preview = maxEdge > QUICK_PREVIEW_MAX_SIZE
      ? await renderImageBuffer(img, previewSize.width, previewSize.height, 0.68)
      : null;
    const thumbnailSize = scaleTo(thumbnailMaxSize);
    const thumbnail = await renderImageBuffer(
      img, thumbnailSize.width, thumbnailSize.height, maxEdge <= thumbnailMaxSize ? 1 : 0.75,
    );
    return { preview, thumbnail };
  } catch (error) {
    console.error('Error generating thumbnail data:', error);
    return { preview: null, thumbnail: null };
  } finally {
    try { img?.close(); } catch (error) { console.warn('Failed to close ImageBitmap:', error); }
    inputBuffer = null;
    inputBlob = null;
  }
};

const generateAndStoreThumbnail = async (
  filePath: string,
  thumbnailFilePath: string,
  imageBitmap: ImageBitmap | undefined,
  fileId: string,
  requestToken: number,
  previewOnly = false,
) => {
  if (previewOnly) {
    const inputBuffer = await fse.readFile(filePath);
    const img = await createImageBitmap(new Blob([inputBuffer]));
    try {
      const maxEdge = Math.max(img.width, img.height);
      const scale = Math.min(1, QUICK_PREVIEW_MAX_SIZE / maxEdge);
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const preview = await renderImageBuffer(img, width, height, 0.68);
      await fse.outputFile(thumbnailFilePath, Buffer.from(preview));
      ctx.postMessage({
        type: 'preview', fileId, thumbnailPath: thumbnailFilePath, requestToken,
      } satisfies IThumbnailMessageResponse);
      return thumbnailFilePath;
    } finally {
      img.close();
    }
  }
  const data = await generateThumbnailData(filePath, imageBitmap);
  if (!data.thumbnail) return '';
  if (data.preview) {
    const previewPath = `${thumbnailFilePath}.preview.${thumbnailFormat}`;
    await fse.outputFile(previewPath, Buffer.from(data.preview));
    ctx.postMessage({
      type: 'preview', fileId, thumbnailPath: previewPath, requestToken,
    } satisfies IThumbnailMessageResponse);
  }
  await fse.outputFile(thumbnailFilePath, Buffer.from(data.thumbnail));
  return thumbnailFilePath;
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
        fileId,
        data.requestToken,
        data.previewOnly,
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
