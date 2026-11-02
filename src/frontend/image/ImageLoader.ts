import fse from 'fs-extra';
import { action } from 'mobx';
import path from 'path';
import StreamZip from 'node-stream-zip';

import ExifIO from 'common/ExifIO';
import { thumbnailFormat, thumbnailMaxSize } from 'common/config';
import { FileDTO, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ClientFile } from '../entities/File';
import ExrLoader from './ExrLoader';
import PsdLoader from './PSDLoader';
import { generateThumbnailUsingWorker, ThumbnailRequestDeferredError } from './ThumbnailGeneration';
import TifLoader from './TifLoader';
import { generateThumbnail, getBlob } from './util';
import { getThumbnailPath, isFileExtensionVideo } from 'common/fs';
import { getPlaceholderStyle } from './placeholderStyle';
import { RendererMessenger } from '../../ipc/renderer';

// Files whose pixels Chromium cannot decode (e.g. some large/iPhone JPEGs, HEVC
// video) but the OS can. We remember them so the preview can serve an OS-decoded
// version. Persisted so it survives restarts (the thumbnail itself is cached).
const OS_DECODE_STORAGE_KEY = 'os-decode-file-ids';

/** Max edge for the OS-decoded preview image (full view), larger than a thumbnail. */
const OS_PREVIEW_MAX_SIZE = 2560;

type FormatHandlerType =
  | 'web'
  | 'tifLoader'
  | 'exrLoader'
  | 'psdLoader'
  | 'extractEmbeddedThumbnailOnly'
  | 'cbzArchive'
  | 'osThumbnail'
  | 'placeholder' // Any file without a specific handler: static colored thumbnail, no preview
  | 'none';

/**
 * Maps known extensions to their display/thumbnail handler.
 * Extensions NOT in this map fall through to 'placeholder' automatically —
 * so adding new extensions to IMG_EXTENSIONS only requires adding them here
 * if they need special rendering. Unknown file types get a placeholder by default.
 */
const FormatHandlers: Partial<Record<string, FormatHandlerType>> = {
  gif: 'web',
  png: 'web',
  apng: 'web',
  jpg: 'web',
  jpeg: 'web',
  jfif: 'web',
  webp: 'web',
  avif: 'web',
  bmp: 'web',
  ico: 'web',
  svg: 'none',
  tif: 'tifLoader',
  tiff: 'tifLoader',
  psd: 'psdLoader',
  kra: 'extractEmbeddedThumbnailOnly',
  cbz: 'cbzArchive',
  pdf: 'osThumbnail',
  cbr: 'osThumbnail',
  // xcf: 'extractEmbeddedThumbnailOnly',
  exr: 'exrLoader',
  mp4: 'web',
  webm: 'web',
  ogg: 'web',
  mov: 'web',
  // All other extensions get 'placeholder' via the getHandler() fallback below
};

/**
 * Returns the display handler for a given extension.
 * Falls back to 'placeholder' for any extension not explicitly mapped.
 */
function getHandler(extension: string): FormatHandlerType {
  return FormatHandlers[extension] ?? 'placeholder';
}

/**
 * Default dimensions assigned to placeholder files.
 * Files with no visual dimensions (audio, 3D, unknown types) need a non-zero
 * value so the masonry layout renders a proper cell.
 */
const PLACEHOLDER_DIMENSIONS = { width: 512, height: 512 };

// Placeholder visual styles live in a shared module so the gallery frame
// (GalleryItem) can use the same per-category colors. See ./placeholderStyle.

type ObjectURL = string;

class ImageLoader {
  private tifLoader: TifLoader;
  private exrLoader: ExrLoader;
  private psdLoader: PsdLoader;

  private srcBufferCache: WeakMap<ClientFile, ObjectURL> = new WeakMap();
  private bufferCacheTimer: WeakMap<ClientFile, number> = new WeakMap();

  /** File ids that need the OS image decoder (Chromium can't render them). */
  private osDecodeIds: Set<string>;

  /**
   * Source modification times already processed in this session.
   * This prevents a thumbnail from being regenerated repeatedly if filesystem
   * timestamp semantics (notably ctime on Linux/network mounts) make the
   * on-disk freshness check unreliable.
   */
  private generatedSourceMtimes = new Map<string, number>();

  constructor(private exifIO: ExifIO) {
    this.tifLoader = new TifLoader();
    this.exrLoader = new ExrLoader();
    this.psdLoader = new PsdLoader();
    this.ensureThumbnail = action(this.ensureThumbnail.bind(this));

    let stored: string[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem(OS_DECODE_STORAGE_KEY) || '[]');
      if (Array.isArray(raw)) {
        stored = raw;
      }
    } catch {
      // ignore malformed preference
    }
    this.osDecodeIds = new Set(stored);
  }

  /** Records a file as needing the OS decoder and persists the set. */
  private markOsDecode(fileId: string): void {
    if (!this.osDecodeIds.has(fileId)) {
      this.osDecodeIds.add(fileId);
      localStorage.setItem(OS_DECODE_STORAGE_KEY, JSON.stringify(Array.from(this.osDecodeIds)));
    }
  }

  /**
   * Generates a thumbnail using the OS (QuickLook on macOS) decoder and writes it
   * to `thumbnailPath`. Used as a fallback when Chromium can't decode the file.
   * Returns true on success.
   */
  private async generateOsThumbnail(absolutePath: string, thumbnailPath: string): Promise<boolean> {
    const png = await RendererMessenger.getQuickLookThumbnail(absolutePath, thumbnailMaxSize);
    if (png === undefined) {
      return false;
    }
    await fse.outputFile(thumbnailPath, png);
    return true;
  }

  /** Returns an object URL with an OS-decoded version of the image, for full preview. */
  private async getOsDecodedBlobUrl(absolutePath: string): Promise<string | undefined> {
    const png = await RendererMessenger.getQuickLookThumbnail(absolutePath, OS_PREVIEW_MAX_SIZE);
    if (png === undefined) {
      return undefined;
    }
    return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  }

  async init(): Promise<void> {
    await Promise.all([this.tifLoader.init(), this.exrLoader.init(), this.psdLoader.init()]);
  }

  needsThumbnail(file: FileDTO) {
    const handler = getHandler(file.extension);
    return (
      handler !== 'web' ||
      file.width > thumbnailMaxSize ||
      file.height > thumbnailMaxSize ||
      file.extension === 'gif' ||
      isFileExtensionVideo(file.extension)
    );
  }

  /**
   * Generates or reuses a thumbnail for a filesystem file that is not registered
   * in Allusion's database. It deliberately shares the same format handlers,
   * decoders, worker pool and thumbnail cache as indexed ClientFiles.
   */
  async ensureExplorerThumbnail(
    absolutePath: string,
    extension: string,
    thumbnailDirectory: string,
    priority = 0,
  ): Promise<string> {
    if (!thumbnailDirectory) {
      throw new Error('Explorer thumbnail directory is not initialized');
    }
    await fse.ensureDir(thumbnailDirectory);
    const normalizedExtension = extension.toLowerCase();
    const thumbnailPath = getThumbnailPath(absolutePath, thumbnailDirectory);
    const fileId = `explorer:${absolutePath}`;
    const sourceStats = await fse.stat(absolutePath);
    const sourceMtime = sourceStats.mtimeMs;

    if (await fse.pathExists(thumbnailPath)) {
      const thumbnailStats = await fse.stat(thumbnailPath);
      if (thumbnailStats.mtimeMs >= sourceMtime || sourceMtime > Date.now()) {
        return `${thumbnailPath}?v=${sourceMtime}`;
      }
    }
    const handlerType = getHandler(normalizedExtension);
    switch (handlerType) {
      case 'web':
        try {
          await generateThumbnailUsingWorker(
            { id: fileId, absolutePath, extension: normalizedExtension },
            thumbnailPath,
            true,
            10000,
            priority,
          );
        } catch (error) {
          if (error instanceof ThumbnailRequestDeferredError) throw error;
          if (!(await this.generateOsThumbnail(absolutePath, thumbnailPath))) throw error;
        }
        break;
      case 'tifLoader':
        await generateThumbnail(this.tifLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        break;
      case 'exrLoader':
        await generateThumbnail(this.exrLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        break;
      case 'psdLoader':
        await generateThumbnail(this.psdLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        break;
      case 'cbzArchive':
        await this.generateCbzThumbnail(absolutePath, thumbnailPath, fileId, priority);
        break;
      case 'osThumbnail':
        if (!(await this.generateOsThumbnail(absolutePath, thumbnailPath))) {
          await this.generatePlaceholderThumbnail(normalizedExtension, thumbnailPath);
        }
        break;
      case 'extractEmbeddedThumbnailOnly': {
        const success = normalizedExtension === 'kra'
          ? await this.extractKritaThumbnail(absolutePath, thumbnailPath)
          : await this.exifIO.extractThumbnail(absolutePath, thumbnailPath);
        if (!success) throw new Error('Could not generate or extract thumbnail');
        break;
      }
      case 'placeholder':
        await this.generatePlaceholderThumbnail(normalizedExtension, thumbnailPath);
        break;
      case 'none':
        return absolutePath;
      default:
        await this.generatePlaceholderThumbnail(normalizedExtension, thumbnailPath);
    }

    const completedStats = await fse.stat(absolutePath);
    this.generatedSourceMtimes.set(fileId, completedStats.mtimeMs);
    return `${thumbnailPath}?v=${completedStats.mtimeMs}`;
  }

  private async generateCbzThumbnail(
    absolutePath: string,
    thumbnailPath: string,
    fileId: string,
    priority = 0,
  ): Promise<void> {
    const zip = new StreamZip.async({ file: absolutePath });
    let temporaryCoverPath: string | undefined;
    try {
      const entries = await zip.entries();
      const imageEntries = Object.values(entries)
        .filter((entry) => entry.isFile && /\.(png|jpe?g|webp|bmp|gif)$/i.test(entry.name))
        .sort((a, b) => {
          const priorityOf = (name: string) => /(^|\/)(cover|front|folder)(\.|$)/i.test(name) ? 0 : 1;
          return priorityOf(a.name) - priorityOf(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true });
        });
      const cover = imageEntries[0];
      if (!cover) throw new Error('No image files found in CBZ archive');

      const extension = path.extname(cover.name).slice(1).toLowerCase();
      temporaryCoverPath = `${thumbnailPath}.cover.${extension}`;
      const coverBuffer = await zip.entryData(cover.name);
      await fse.outputFile(temporaryCoverPath, coverBuffer);
      await generateThumbnailUsingWorker(
        { id: `cbz-cover:${fileId}`, absolutePath: temporaryCoverPath, extension },
        thumbnailPath,
        true,
        10000,
        priority,
      );
    } finally {
      await zip.close().catch(console.warn);
      if (temporaryCoverPath) await fse.remove(temporaryCoverPath).catch(console.warn);
    }
  }

  async ensurePreviewThumbnail(file: ClientFile, priority = 0): Promise<void> {
    const thumbnailPath = file.thumbnailPath.split('?')[0];
    const previewPath = `${thumbnailPath}.preview.${thumbnailFormat}`;

    if (await fse.pathExists(previewPath)) {
      file.setPreviewThumbnailPath(previewPath);
      return;
    }
    if (!(await fse.pathExists(thumbnailPath))) return;

    try {
      await generateThumbnailUsingWorker(
        file,
        previewPath,
        true,
        10000,
        priority,
        (generatedPreviewPath) => file.setPreviewThumbnailPath(generatedPreviewPath),
        thumbnailPath,
        true,
      );
    } catch (error) {
      console.warn('Could not generate cached preview thumbnail:', file.absolutePath, error);
    }
  }

  async ensureThumbnail(file: ClientFile, priority = 0): Promise<boolean> {
    // Never regenerate over a user-assigned custom thumbnail.
    if (file.hasCustomThumbnail) {
      return false;
    }

    const { extension, absolutePath, thumbnailPath } = {
      extension: file.extension,
      absolutePath: file.absolutePath,
      thumbnailPath: file.thumbnailPath.split('?')[0],
    };

    if (await fse.pathExists(thumbnailPath)) {
      const fileStats = await fse.stat(absolutePath);
      const sourceMtime = fileStats.mtimeMs;

      // If this exact source version was already generated in this session,
      // trust that result instead of repeatedly decoding it.
      if (this.generatedSourceMtimes.get(file.id) === sourceMtime) {
        return false;
      }

      const thumbStats = await fse.stat(thumbnailPath);
      // Compare modification times rather than ctime. ctime is inode metadata
      // change time and is not a reliable indication of thumbnail freshness on
      // every filesystem.
      if (thumbStats.mtimeMs >= sourceMtime || sourceMtime > Date.now()) {
        return false;
      }
    }

    const handlerType = getHandler(extension);
    switch (handlerType) {
      case 'web':
        try {
          await generateThumbnailUsingWorker(file, thumbnailPath, true, 10000, priority, (previewPath) => {
            file.setPreviewThumbnailPath(previewPath);
          });
          updateThumbnailPath(file, thumbnailPath);
        } catch (error) {
          // A low-priority queued request was deferred, not failed to decode.
          // Do not invoke the expensive OS fallback; a later visible-priority
          // request can enqueue it again.
          if (error instanceof ThumbnailRequestDeferredError) {
            throw error;
          }
          // Chromium couldn't decode this file (e.g. some large/iPhone JPEGs, or
          // HEVC/ProRes video). Fall back to the OS decoder for a poster thumbnail.
          if (await this.generateOsThumbnail(absolutePath, thumbnailPath)) {
            this.markOsDecode(file.id);
            updateThumbnailPath(file, thumbnailPath);
          } else {
            throw new Error('Could not generate thumbnail');
          }
        }
        break;
      case 'tifLoader':
        await generateThumbnail(this.tifLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'exrLoader':
        await generateThumbnail(this.exrLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'cbzArchive':
        await this.generateCbzThumbnail(absolutePath, thumbnailPath, file.id, priority);
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'osThumbnail':
        if (!(await this.generateOsThumbnail(absolutePath, thumbnailPath))) {
          await this.generatePlaceholderThumbnail(extension, thumbnailPath);
        }
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'extractEmbeddedThumbnailOnly':
        let success = false;
        if (extension === 'kra') {
          success = await this.extractKritaThumbnail(absolutePath, thumbnailPath);
        } else {
          success = await this.exifIO.extractThumbnail(absolutePath, thumbnailPath);
        }
        if (!success) {
          throw new Error('Could not generate or extract thumbnail');
        } else {
          updateThumbnailPath(file, thumbnailPath);
        }
        break;
      case 'psdLoader':
        await generateThumbnail(this.psdLoader, absolutePath, thumbnailPath, thumbnailMaxSize);
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'placeholder':
        await this.generatePlaceholderThumbnail(extension, thumbnailPath);
        updateThumbnailPath(file, thumbnailPath);
        break;
      case 'none':
        file.setThumbnailPath(file.absolutePath);
        break;
      default:
        console.warn('Unhandled extension', file.absolutePath, extension);
        // Treat as placeholder rather than throwing — any unknown extension gets a colored tile
        await this.generatePlaceholderThumbnail(extension, thumbnailPath);
        updateThumbnailPath(file, thumbnailPath);
    }
    // Remember the source version only after successful generation/handling.
    const completedSourceStats = await fse.stat(absolutePath);
    this.generatedSourceMtimes.set(file.id, completedSourceStats.mtimeMs);
    return true;
  }

  async getImageSrc(file: ClientFile): Promise<string | undefined> {
    const handlerType = getHandler(file.extension);
    switch (handlerType) {
      case 'web':
        if (this.osDecodeIds.has(file.id)) {
          // Chromium can't render the original. Videos have no inline playback
          // here (e.g. HEVC) — show the poster thumbnail; for images, serve an
          // OS-decoded copy so the full preview works.
          if (isFileExtensionVideo(file.extension)) {
            return file.thumbnailPath.split('?')[0];
          }
          const cached = this.srcBufferCache.get(file);
          const src = cached ?? (await this.getOsDecodedBlobUrl(file.absolutePath));
          if (src !== undefined) {
            this.updateCache(file, src);
            return src;
          }
        }
        return file.absolutePath;
      case 'tifLoader': {
        const src =
          this.srcBufferCache.get(file) ?? (await getBlob(this.tifLoader, file.absolutePath));
        this.updateCache(file, src);
        return src;
      }
      case 'exrLoader': {
        const src =
          this.srcBufferCache.get(file) ?? (await getBlob(this.exrLoader, file.absolutePath));
        this.updateCache(file, src);
        return src;
      }
      case 'psdLoader': {
        const src =
          this.srcBufferCache.get(file) ?? (await getBlob(this.psdLoader, file.absolutePath));
        this.updateCache(file, src);
        return src;
      }
      case 'extractEmbeddedThumbnailOnly':
        if (file.extension === 'kra') {
          const src =
            this.srcBufferCache.get(file) ??
            (await this.extractKritaMergedImageAsBlobURL(file.absolutePath));
          src && this.updateCache(file, src);
          return src;
        }
        return undefined;
      case 'cbzArchive':
      case 'osThumbnail':
      case 'placeholder':
        // The placeholder/cover thumbnail is the full representation — reuse for slide/preview mode
        return file.thumbnailPath.split('?')[0];
      case 'none':
        return undefined;
      default:
        // Unknown extension: same as placeholder
        return file.thumbnailPath.split('?')[0];
    }
  }

  /** Returns PLACEHOLDER_DIMENSIONS for non-visual files, real dimensions otherwise. */
  async getImageResolution(absolutePath: string): Promise<{ width: number; height: number }> {
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const handler = getHandler(ext);

    // Non-visual files have no meaningful dimensions — return a fixed square
    // so the masonry layout renders a proper cell instead of a 0×0 ghost.
    if (handler === 'placeholder' || handler === 'osThumbnail' || handler === 'cbzArchive') {
      return PLACEHOLDER_DIMENSIONS;
    }

    const dimensions = await this.exifIO.getDimensions(absolutePath);

    if (dimensions.width === 0 || dimensions.height === 0) {
      if (absolutePath.toLowerCase().endsWith('psd')) {
        try {
          const psdData = await this.psdLoader.decode(await fse.readFile(absolutePath));
          dimensions.width = psdData.width;
          dimensions.height = psdData.height;
        } catch (e) {}
      }
      if (absolutePath.toLowerCase().endsWith('.kra')) {
        return await this.getKraDimensions(absolutePath);
      }
    }

    return dimensions;
  }

  /**
   * Generates a static colored placeholder thumbnail for any non-visual file type.
   * The result is a real .webp file written to disk — the rest of the pipeline
   * (caching, display, gallery) requires zero changes.
   */
  private async generatePlaceholderThumbnail(
    extension: string,
    thumbnailFilePath: string,
  ): Promise<void> {
    const SIZE = 512;
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D canvas context for placeholder thumbnail');
    }

    const style = getPlaceholderStyle(extension);

    // Background
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Border
    const borderWidth = 6;
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = borderWidth;
    ctx.strokeRect(borderWidth / 2, borderWidth / 2, SIZE - borderWidth, SIZE - borderWidth);

    // Extension label (e.g. ".MP3")
    ctx.fillStyle = style.accent;
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(extension ? `.${extension.toUpperCase()}` : 'FILE', SIZE / 2, SIZE / 2);

    // Category sublabel (e.g. "AUDIO")
    ctx.globalAlpha = 0.5;
    ctx.font = '32px sans-serif';
    ctx.fillText(style.label, SIZE / 2, SIZE / 2 + 70);
    ctx.globalAlpha = 1;

    const blob = await canvas.convertToBlob({
      type: `image/${thumbnailFormat}`,
      quality: 0.85,
    });
    const buffer = await blob.arrayBuffer();
    await fse.outputFile(thumbnailFilePath, Buffer.from(buffer));
  }

  private async extractKritaThumbnail(absolutePath: string, outputPath: string) {
    const zip = new StreamZip.async({ file: absolutePath });
    let success = false;
    console.debug('Extracting thumbnail from', absolutePath);
    try {
      const count = await zip.extract('preview.png', outputPath);
      success = count === 1;
    } catch (e) {
      console.error('Could not extract thumbnail from .kra file', absolutePath, e);
    } finally {
      zip.close().catch(console.warn);
    }
    return success;
  }

  private async readKraEntry(filePath: string, entryName: string): Promise<Buffer> {
    const zip = new StreamZip.async({ file: filePath });
    try {
      return await zip.entryData(entryName);
    } finally {
      await zip.close().catch(console.warn);
    }
  }

  private async extractKritaMergedImageAsBlobURL(filePath: string): Promise<string | undefined> {
    try {
      const buffer = await this.readKraEntry(filePath, 'mergedimage.png');
      const blob = new Blob([buffer], { type: 'image/png' });
      return URL.createObjectURL(blob);
    } catch (e) {
      console.error('Could not extract mergedimage.png from', filePath, e);
      return undefined;
    }
  }

  private async getKraDimensions(filePath: string): Promise<{ width: number; height: number }> {
    const zip = new StreamZip.async({ file: filePath });
    try {
      const xmlBuffer = await zip.entryData('maindoc.xml');
      const xml = xmlBuffer.toString('utf-8');
      const widthStr = extractAttribute(xml, 'IMAGE', 'width');
      const heightStr = extractAttribute(xml, 'IMAGE', 'height');
      return {
        width: widthStr ? parseInt(widthStr, 10) : 0,
        height: heightStr ? parseInt(heightStr, 10) : 0,
      };
    } catch (e) {
      console.error('Could not extract dimensions from maindoc.xml in', filePath, e);
      return { width: 0, height: 0 };
    } finally {
      await zip.close().catch(console.warn);
    }
  }

  private updateCache(file: ClientFile, src: ObjectURL) {
    this.srcBufferCache.set(file, src);
    const timer = this.bufferCacheTimer.get(file);
    clearTimeout(timer);
    this.bufferCacheTimer.set(
      file,
      window.setTimeout(() => {
        URL.revokeObjectURL(src);
        this.srcBufferCache.delete(file);
      }, 60_000),
    );
  }
}

export default ImageLoader;

const updateThumbnailPath = action((file: ClientFile, thumbnailPath: string) => {
  file.setThumbnailPath(thumbnailPath);
});

function extractAttribute(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*\\b${attr}="(\\d+)"`);
  const match = xml.match(regex);
  return match ? match[1] : null;
}