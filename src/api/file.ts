import { ID } from './id';
import { ExtraProperties } from './extraProperty';

export type FileStats = {
  absolutePath: string;
  /** When file was last modified on disk */
  dateModified: Date;
  /** When file was created on disk */
  dateCreated: Date;
  /** Current size of the file in bytes */
  size: number;
  /** A unique identifier of the file created by the OS, stays identical even when renaming/moving files */
  ino: string;
};

export type FileDTO = {
  id: ID;
  /** Identifier for a file that persists after renaming/moving (retrieved from fs.Stats.ino) */
  ino: string;
  locationId: ID;
  /** Path relative to Location */
  relativePath: string;
  absolutePath: string;
  tags: ID[];
  tagSorting: FILE_TAGS_SORTING_TYPE;
  extraProperties: ExtraProperties;
  /** When the file was imported into Allusion */
  dateAdded: Date;
  /** When the file was modified in Allusion, not related to OS modified date */
  dateModified: Date;
  /** Original OS dateModified for checking when searching for overwritten files */
  dateModifiedOS: Date;
  /** When the file was last indexed in Allusion */
  dateLastIndexed: Date;

  /** Duplicate data; also exists as part of the absolutePath. Used for DB queries */
  name: string;
  /**
   * File extension in lowercase, without the dot.
   * Can be any string — Allusion indexes all file types, and the extension
   * determines how the file is displayed (known formats render normally,
   * unknown formats show a placeholder thumbnail).
   */
  extension: string;
  /** Size in bytes */
  size: number;
  width: number;
  height: number;
  /** Date when this file was created (from the OS, not related to Allusion) */
  dateCreated: Date;
};

/**
 * The registry of file extensions that Allusion knows how to render.
 * This is NOT used as a gate for indexing — all files are indexed regardless.
 * It is used to determine the display/thumbnail strategy for a file.
 */
export const IMG_EXTENSIONS = [
  'gif',
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'avif',
  'tif',
  'tiff',
  'bmp',
  'ico',
  'svg',
  'psd',
  'kra',

  // 'xcf', // Gimp
  'exr', // OpenEXR
  // 'raw', there are many RAW file extensions :( https://fileinfo.com/filetypes/camera_raw
  // 'heic', // not supported by Sharp out of the box https://github.com/lovell/sharp/issues/2871
  'mp4',
  'webm',
  'ogg',
  'mov',
  // Audio — placeholder thumbnail, no playback
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'opus',
  'wma',
  // 3D / Project files — placeholder thumbnail
  'blend',
  // Document and comic-book formats with OS/embedded cover thumbnail support
  'pdf',
  'cbz',
  'cbr',
] as const;

/** Union type of all extensions Allusion has explicit rendering support for. */
export type IMG_EXTENSIONS_TYPE = (typeof IMG_EXTENSIONS)[number];

/**
 * A user-managed file extension entry.
 * The user can add any extension to this list and toggle whether it is indexed.
 * Extensions NOT in this list are indexed by default (everything-in approach).
 */
export type ManagedExtension = {
  /** Extension in lowercase without the dot, e.g. "exr", "blend" */
  extension: string;
  /** When true, files with this extension are skipped during indexing */
  blocked: boolean;
};

export const FILE_TAGS_SORTING = ['insertion', 'hierarchy'] as const;
export type FILE_TAGS_SORTING_TYPE = (typeof FILE_TAGS_SORTING)[number];