export interface ExplorerBookmark {
  id: string;
  name: string;
  path: string;
  includeSubfolders: boolean;
}

const STORAGE_KEY = 'allusion-explorer-bookmarks';
export const EXPLORER_BOOKMARKS_CHANGED = 'allusion-explorer-bookmarks-changed';

export const getExplorerBookmarks = (): ExplorerBookmark[] => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter(
          (item): item is ExplorerBookmark =>
            !!item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.path === 'string' &&
            typeof item.includeSubfolders === 'boolean',
        )
      : [];
  } catch {
    return [];
  }
};

export const saveExplorerBookmarks = (bookmarks: ExplorerBookmark[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  window.dispatchEvent(new Event(EXPLORER_BOOKMARKS_CHANGED));
};
