let folderLoadStartedAt: number | undefined;
let folderLoadPath: string | undefined;
let firstVisibleTileReported = false;

/** Starts a temporary end-to-end timer when an Explorer folder scan begins. */
export const startExplorerFolderTiming = (absolutePath: string): void => {
  folderLoadStartedAt = performance.now();
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
  console.info(
    `[perf] Explorer first visible tile: ${Math.round(performance.now() - folderLoadStartedAt)} ms`,
    folderLoadPath,
  );
};
