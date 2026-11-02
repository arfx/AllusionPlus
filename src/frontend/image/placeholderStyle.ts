/**
 * Visual style per file category, shared between the placeholder thumbnail
 * generator (ImageLoader) and the gallery frame rendering (GalleryItem).
 *
 * - bg: canvas background for generated placeholder tiles
 * - accent: the colored border + filetype label color
 * - label: short category name shown on the generated tile
 */
export type PlaceholderStyle = { bg: string; accent: string; label: string };

export const PLACEHOLDER_STYLE: Record<string, PlaceholderStyle> = {
  mp3: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  wav: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  flac: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  aac: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  m4a: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  opus: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  wma: { bg: '#1a1028', accent: '#8b5cf6', label: 'AUDIO' },
  blend: { bg: '#1a1100', accent: '#e87d0d', label: 'BLEND' },
  pdf: { bg: '#281414', accent: '#ef4444', label: 'PDF' },
  cbz: { bg: '#14202a', accent: '#38bdf8', label: 'COMIC' },
  cbr: { bg: '#14202a', accent: '#38bdf8', label: 'COMIC' },
};

export const DEFAULT_PLACEHOLDER_STYLE: PlaceholderStyle = {
  bg: '#1a1a1a',
  accent: '#555555',
  label: 'FILE',
};

/** Returns the placeholder style for an extension, falling back to the default. */
export function getPlaceholderStyle(extension: string): PlaceholderStyle {
  return PLACEHOLDER_STYLE[extension] ?? DEFAULT_PLACEHOLDER_STYLE;
}
