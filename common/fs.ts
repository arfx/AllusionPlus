// Needed for test:
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
import fse from 'fs-extra';
import { thumbnailFormat } from '../common/config';
import { IS_DEV } from './process';
import { IMG_EXTENSIONS_TYPE } from 'src/api/file';

export function getThumbnailPath(
  filePath: string,
  thumbnailDirectory: string,
  format: string = thumbnailFormat,
): string {
  const baseFilename = path.basename(filePath, path.extname(filePath));

  // Hash is needed to avoid files with the same name to clash with each other, when they come from different paths
  const hash = hashString(filePath);

  return path.join(thumbnailDirectory, `${baseFilename}-${hash}.${format}`);
}

/**
 * Path for a user-assigned ("forged") thumbnail. These live in a separate
 * `forged` subfolder keyed by the stable file id, so the auto thumbnail
 * generator and cleanup never overwrite or delete them, and they survive
 * the file being moved or renamed.
 */
export function getForgedThumbnailPath(fileId: string, thumbnailDirectory: string): string {
  return path.join(thumbnailDirectory, 'forged', `${fileId}.png`);
}

/** Use this for any <img src attribute! */
export function encodeFilePath(filePath: string): string {
  if (filePath.startsWith('data:image') || filePath.startsWith('blob:')) {
    return filePath;
  }
  // Take into account weird file names like "C:/Images/https_%2F%2Fcdn/.../my-image.jpg"
  const basename = path.basename(filePath);
  let basepath = filePath.slice(0, filePath.length - basename.length);
  let filename = filePath.slice(basepath.length);
  // but don't encode url params, we need those to stay intact, e.g. myImage.jpg?v=1
  // unix allows question marks in filenames though, not bothering with that
  let params = '';
  const paramsIndex = filename.lastIndexOf('?');
  // can't be first char of filname, so > 0
  if (paramsIndex > 0) {
    params = filename.slice(paramsIndex);
    filename = filename.slice(0, paramsIndex);
  }
  // edge case for #
  basepath = basepath.replace(/#/g, '%23');
  return `file://${basepath}${encodeURIComponent(filename)}${params}`;
}

export async function isDirEmpty(dir: string) {
  const dirContents = await fse.readdir(dir);
  return dirContents.length === 0 || (dirContents.length === 1 && dirContents[0] === '.DS_Store');
}

// ---------------------------------------------------------------------------
// Video extensions
// ---------------------------------------------------------------------------

const VideoExtensions = [
  'webm',
  'mp4',
  'ogg',
  'mov',
] as const satisfies readonly IMG_EXTENSIONS_TYPE[];
export type VideoExtensionsType = (typeof VideoExtensions)[number];

/**
 * Returns true if the extension is a known video format.
 * Accepts any string so it can be called with FileDTO.extension (which is now `string`).
 */
export function isFileExtensionVideo(fileExtension: string): boolean {
  return (VideoExtensions as readonly string[]).includes(fileExtension);
}

// ---------------------------------------------------------------------------
// Native image-compatible extensions (can be used directly as <img src>)
// ---------------------------------------------------------------------------

const NativeImageCompatibleExtensions = [
  'png',
  'jpg',
  'jpeg',
  'jfif',
] as const satisfies readonly IMG_EXTENSIONS_TYPE[];
export type NativeImageCompatibleExtensionsType = (typeof NativeImageCompatibleExtensions)[number];

/**
 * Returns true if the extension can be used directly as an <img> src without conversion.
 * Accepts any string so it can be called with FileDTO.extension (which is now `string`).
 */
export function isNativeImageCompatible(fileExtension: string): boolean {
  return (NativeImageCompatibleExtensions as readonly string[]).includes(fileExtension);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function hashString(s: string) {
  let hash = 0;
  let chr = 0;
  if (s.length === 0) {
    return hash;
  }
  for (let i = 0; i < s.length; i++) {
    chr = s.charCodeAt(i);
    // tslint:disable-next-line: no-bitwise
    hash = (hash << 5) - hash + chr;
    // tslint:disable-next-line: no-bitwise
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

/**
 * Gets the path to a resource set up in `"extraResources"` in the package.json.
 * See https://www.electron.build/configuration/contents#extraresources
 */
export function getExtraResourcePath(resourcePath: string): string {
  const relativeResourcesPath = (IS_DEV ? '../' : '../../') + 'resources';
  return path.resolve(__dirname, relativeResourcesPath, resourcePath);
}