import { isPerfEnabled, recordPerf } from '../../../common/perf';

let folderLoadStartedAt: number | undefined;
let folderLoadPath: string | undefined;
let firstVisibleTileReported = false;
let visibleTilesRemaining = 0;
let allVisibleStartedAt: number | undefined;

export const startExplorerVisibleTileTiming = (visibleCount: number): void => {
  visibleTilesRemaining = visibleCount;
  allVisibleStartedAt = visibleCount && folderLoadStartedAt !== undefined ? folderLoadStartedAt : undefined;
};

export const reportVisibleExplorerTileLoaded = (): void => {
  if (allVisibleStartedAt === undefined && visibleTilesRemaining > 0) {
    allVisibleStartedAt = performance.now();
  }
  if (!isPerfEnabled() || allVisibleStartedAt === undefined || visibleTilesRemaining <= 0) return;
  visibleTilesRemaining--;
  if (visibleTilesRemaining === 0) {
    recordPerf('explorer.allTiles', performance.now() - allVisibleStartedAt);
    allVisibleStartedAt = undefined;
  }
};

/** Starts a temporary end-to-end timer when an Explorer folder scan begins. */
export const startExplorerFolderTiming = (absolutePath: string): void => {
  folderLoadStartedAt = performance.now();
  allVisibleStartedAt = undefined;
  visibleTilesRemaining = 0;
  folderLoadPath = absolutePath;
  firstVisibleTileReported = false;
};

/** Reports the first successfully decoded tile for the currently opening folder. */
export const reportFirstVisibleExplorerTile = (absolutePath: string): void => {
  if (folderLoadStartedAt === undefined || firstVisibleTileReported || !folderLoadPath) return;
  const normalize = (value: string) => value.replace(/[\\/]+$/, '').toLocaleLowerCase();
  const folder = normalize(folderLoadPath);
  const file = normalize(absolutePath);
  const separator = folder.includes('/') ? '/' : '\\';
  if (file !== folder && !file.startsWith(`${folder}${separator}`)) return;
  firstVisibleTileReported = true;
  if (isPerfEnabled()) {
    recordPerf('explorer.firstTile', performance.now() - folderLoadStartedAt);
  }
};
