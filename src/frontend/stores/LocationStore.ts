import fse from 'fs-extra';
import { action, makeObservable, observable, runInAction } from 'mobx';
import SysPath from 'path';

import { getThumbnailPath } from 'common/fs';
import { batchReducer, promiseAllLimit } from 'common/promise';
import { DataStorage, makeFileBatchFetcher } from '../../api/data-storage';
import { OrderDirection } from '../../api/data-storage-search';
import { FileStats, FileDTO, ManagedExtension, IMG_EXTENSIONS } from '../../api/file';
import { ID, generateId } from '../../api/id';
import { LocationDTO } from '../../api/location';
import { RendererMessenger } from '../../ipc/renderer';
import { AppToaster } from '../components/Toaster';
import { ClientFile, getMetaData, mergeMovedFile } from '../entities/File';
import { ClientLocation, ClientSubLocation } from '../entities/Location';
import { ClientStringSearchCriteria } from '../entities/SearchCriteria';
import ImageLoader from '../image/ImageLoader';
import RootStore from './RootStore';
import { appendToIgnoreList } from './ignoreList';
import { ClientTag } from '../entities/Tag';
import { IS_MAC, IS_WIN } from 'common/process';
import { BackendType } from '@parcel/watcher';
import { execSync } from 'child_process';
import { debounce } from 'common/timeout';

const PREFERENCES_STORAGE_KEY = 'location-store-preferences';
type Preferences = { managedExtensions: ManagedExtension[]; excludeAllExceptIncluded?: boolean };

/**
 * Seed the settings list with every format Allusion knows how to display.
 * All are enabled by default; users can still add custom extensions or block formats.
 */
const DEFAULT_MANAGED_EXTENSIONS: ManagedExtension[] = IMG_EXTENSIONS.map((extension) => ({
  extension,
  blocked: false,
}));
/**
 * Compares metadata of two files to determine whether the files are (likely to be) identical
 * Note: note comparing size, since it can change, e.g. when writing tags to file metadata.
 *   Could still include it, but just to check whether it's in the same ballpark
 */
function areFilesIdenticalBesidesName(a: FileDTO, b: FileDTO): boolean {
  return (
    a.ino === b.ino ||
    (a.width === b.width &&
      a.height === b.height &&
      a.dateCreated.getTime() === b.dateCreated.getTime())
  );
}

function isWatchmanInstalled(): boolean {
  try {
    execSync('watchman --version', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

class LocationStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;
  watcherSnapshotDirectory!: string;
  PARCEL_WATCHER_BACKEND!: BackendType;

  readonly locationList = observable<ClientLocation>([]);

  // User-managed list of file extensions. Everything is indexed by default;
  // entries marked `blocked` are skipped during scan and live watching.
  // Global option for now, needs restart. TODO: Maybe per location/sub-location?
  readonly managedExtensions = observable.array<ManagedExtension>([]);
  @observable excludeAllExceptIncluded = false;
  private filesToUpdate: Map<string, FileStats> = new Map();
  /** Count of new files detected by the watcher awaiting a user-triggered refresh. */
  private pendingNewFiles = 0;
  /** Timestamp (ms) of the last focus-triggered location refresh, for throttling. */
  private lastFocusRefresh = 0;
  debouncedUpdateFilesToUpdate: () => Promise<void>;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    makeObservable(this);

    this.debouncedUpdateFilesToUpdate = debounce(this.updateFilestoUpdate, 1200).bind(this);
  }

  @action async init(): Promise<void> {
    // Restore preferences
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) || '') as Preferences;
      const saved = prefs.managedExtensions ?? [];
      this.excludeAllExceptIncluded = Boolean(prefs.excludeAllExceptIncluded);
      const savedByExtension = new Map(saved.map((entry) => [entry.extension, entry]));
      const managed = [
        ...DEFAULT_MANAGED_EXTENSIONS.map(
          (entry) => savedByExtension.get(entry.extension) ?? entry,
        ),
        ...saved.filter(
          (entry) =>
            !DEFAULT_MANAGED_EXTENSIONS.some(
              (defaultEntry) => defaultEntry.extension === entry.extension,
            ),
        ),
      ];
      runInAction(() => this.managedExtensions.replace(managed));
    } catch (e) {
      // If no preferences found, use defaults
      runInAction(() => {
        this.managedExtensions.replace(DEFAULT_MANAGED_EXTENSIONS.slice());
        this.excludeAllExceptIncluded = false;
      });
    }
    this.watcherSnapshotDirectory = await RendererMessenger.getWatcherSnapshotsDirectory();

    // Fix the console popup bug when initializing the watcher by ensuring the watcher backend to use.
    // look at https://github.com/eclipse-theia/theia/pull/16335
    const isWatchman = isWatchmanInstalled();
    this.PARCEL_WATCHER_BACKEND = isWatchman
      ? 'watchman'
      : IS_WIN
      ? 'windows'
      : IS_MAC
      ? 'fs-events'
      : 'inotify';
    console.debug('Watcher backend:', this.PARCEL_WATCHER_BACKEND);

    // Get dirs from backend
    const dirs = await this.backend.fetchLocations();

    // backwards compatibility
    dirs.sort((a, b) =>
      a.index === b.index ? a.dateAdded.getTime() - b.dateAdded.getTime() : a.index - b.index,
    );

    const locations = runInAction(() =>
      dirs.map(
        (dir, i) =>
          new ClientLocation(
            this,
            dir.id,
            dir.path,
            dir.dateAdded,
            dir.subLocations,
            dir.tags,
            runInAction(() => this.blockedExtensions),
            this.excludeAllExceptIncluded,
            runInAction(() => this.includedExtensions),
            dir.index ?? i,
            dir.isWatchingFiles,
          ),
      ),
    );
    runInAction(() => this.locationList.replace(locations));
    runInAction(() => {
      for (const location of this.locationList) {
        location.init();
      }
    });
  }

  save(loc: LocationDTO): void {
    this.backend.saveLocation(loc);
  }

  retryToastTimeout: NodeJS.Timeout | undefined;
  private showLocationProcessToast(
    action: 'show' | 'cancel-retry' | 'show-missing' | 'hide',
    msgMode: 'update' | 'watch',
    location: ClientLocation | { name: 'None'; id: 'None' } = { name: 'None', id: 'None' },
    total: number = 0,
    progress: number = 0,
  ) {
    const watch = msgMode === 'watch';
    const progressToastKey = 'progress';
    switch (action) {
      case 'show':
        const toastsMsg = watch ? 'Syncing locations' : 'Looking for new images';

        AppToaster.show(
          {
            message: `${toastsMsg}... [${progress + 1} / ${total}]`,
            timeout: 6000,
          },
          progressToastKey,
        );

        // TODO: Add a maximum timeout for init: sometimes it's hanging for me. Could also be some of the following steps though
        // added a retry toast for now, can't figure out the cause, and it's hard to reproduce
        // FIXME: Toasts should not be abused for error handling. Create some error messaging mechanism.
        this.retryToastTimeout = setTimeout(() => {
          AppToaster.show(
            {
              message: `${toastsMsg}... [${progress + 1} / ${total}]`,
              timeout: 6000,
            },
            progressToastKey,
          );
          AppToaster.show(
            {
              message: 'This appears to be taking longer than usual.',
              timeout: 10000,
              clickAction: {
                onClick: RendererMessenger.reload,
                label: 'Retry?',
              },
            },
            'retry-init',
          );
        }, 20000);
        break;
      case 'cancel-retry':
        clearTimeout(this.retryToastTimeout);
        AppToaster.dismiss('retry-init');
        break;
      case 'show-missing':
        AppToaster.show(
          {
            message: `Cannot ${watch ? 'watch' : 'find'} Location "${location.name}"`,
            timeout: 6000,
          },
          // a key such that the toast can be dismissed automatically on recovery
          `missing-loc-${location.id}`,
        );
        break;
      case 'hide':
      default:
        AppToaster.dismiss(progressToastKey);
        break;
    }
  }

  @action async watchLocations(locations?: ClientLocation | ClientLocation[]): Promise<void> {
    let locs: ClientLocation[];
    if (locations === undefined) {
      locs = this.locationList;
    } else if (!Array.isArray(locations)) {
      locs = [locations];
    } else {
      locs = locations;
    }
    locs = locs.filter((l) => l.isWatchingFiles);
    const len = locs.length;
    for (let i = 0; i < len; i++) {
      const location = locs[i];
      this.showLocationProcessToast('show', 'watch', location, len, i);
      const success = await location.watch();
      this.showLocationProcessToast('cancel-retry', 'watch', location);
      if (!success) {
        this.showLocationProcessToast('show-missing', 'watch', location);
      }
    }
    this.showLocationProcessToast('hide', 'watch');
  }

  /** Manually synchronizes the database files and locations with the current file system state using a brute-force scan. */
  @action async updateLocations(locations?: ClientLocation | ClientLocation[]): Promise<boolean> {
    let locs: ClientLocation[];
    const processAllLocations = locations === undefined;
    if (processAllLocations) {
      locs = this.locationList.slice();
    } else if (!Array.isArray(locations)) {
      locs = [locations];
    } else {
      locs = locations;
    }
    locs.forEach((loc) => (loc.isRefreshing = true));
    const foundNewFiles = await this.compareLocations(locs);
    // update tagstore location tags
    this.rootStore.tagStore.refreshLocationTags(processAllLocations ? undefined : locs);
    if (foundNewFiles) {
      this.rootStore.fileStore.refetch();
    }
    return foundNewFiles;
  }

  /** Derives the location(s) the current search query is scoped into (via absolutePath criteria). */
  getActiveSearchedLocations(): ClientLocation[] {
    const includePaths = (this.rootStore.uiStore.searchCriteriaList as any[])
      .filter(
        (c) => c.key === 'absolutePath' && c.operator === 'startsWith' && typeof c.value === 'string',
      )
      .map((c) => c.value as string);
    if (includePaths.length === 0) {
      return [];
    }
    return this.locationList.filter((loc) =>
      includePaths.some((value) => value.startsWith(loc.path + SysPath.sep)),
    );
  }

  /**
   * Rescans the currently-viewed location(s) for new files when the window regains
   * focus. No-op unless the setting is enabled, a location-scoped view is active,
   * we are not already refreshing, and we haven't refreshed in the last 10 seconds.
   */
  @action.bound async refreshActiveLocationOnFocus(): Promise<void> {
    const uiStore = this.rootStore.uiStore;
    if (!uiStore.isRefreshActiveLocationOnFocusEnabled || uiStore.isRefreshing) {
      return;
    }
    const now = Date.now();
    if (now - this.lastFocusRefresh < 10_000) {
      return;
    }
    const locations = this.getActiveSearchedLocations();
    if (locations.length === 0) {
      return;
    }
    this.lastFocusRefresh = now;
    await this.updateLocations(locations);
  }

  /** Shows a sticky, click-to-refresh toast summarising new files found by the watcher. */
  private notifyPendingNewFile(): void {
    this.pendingNewFiles += 1;
    const count = this.pendingNewFiles;
    AppToaster.show(
      {
        message: `${count} new file${count > 1 ? 's' : ''} detected`,
        timeout: 0,
        clickAction: {
          label: 'Refresh',
          onClick: () => {
            this.pendingNewFiles = 0;
            this.rootStore.fileStore.refetch();
            AppToaster.dismiss('new-files');
          },
        },
      },
      'new-files',
    );
  }

  // Returns whether files have been added, changed or removed
  @action async compareLocations(locations: ClientLocation[]): Promise<boolean> {
    let foundNewFiles = false;
    const len = locations.length;

    // For every location, find created/moved/deleted files, and update the database accordingly.
    // TODO: Do this in a web worker, not in the renderer thread!
    for (let i = 0; i < len; i++) {
      const location = locations[i];

      this.showLocationProcessToast('show', 'update', location, len, i);

      const wasInitialized = runInAction(() => location.isInitialized);
      if (!wasInitialized) {
        console.group(`Initializing location ${location.name}`);
        await location.init();
      }
      const diskFiles = await (async () => {
        const [files, rootDirectoryItem] = await location.getDiskFilesAndDirectories();
        location.refreshSublocations(rootDirectoryItem);
        return files;
      })();
      const diskFileMap = new Map<string, FileStats>(
        diskFiles?.map((f) => [f.absolutePath, f]) ?? [],
      );

      this.showLocationProcessToast('cancel-retry', 'update', location);

      if (diskFiles === undefined) {
        this.showLocationProcessToast('show-missing', 'update', location);
        continue;
      }

      console.log('Finding created files...');

      // Find all files that have been created (those on disk but not in DB)
      // Find all files of this location that have been removed (those in DB but not on disk anymore)
      const { createdStats, missingFiles: missingFilesFromDB } = await this.backend.compareFiles(
        location.id,
        diskFiles,
      );

      // Files omitted by the active format filter are not merely missing from disk:
      // they must be removed from the index, otherwise previously indexed formats
      // remain visible after switching to whitelist mode.
      const excludedByFormat = missingFilesFromDB.filter((file) => {
        const extension = SysPath.extname(file.absolutePath).slice(1).toLowerCase();
        return (
          (extension && location.blockedExtensions.has(extension)) ||
          (location.excludeAllExceptIncluded &&
            (!extension || !location.includedExtensions.has(extension)))
        );
      });
      if (excludedByFormat.length > 0) {
        await this.backend.removeFiles(excludedByFormat.map((file) => file.id));
        for (const file of excludedByFormat) {
          this.rootStore.fileStore.removeThumbnail(file.absolutePath);
        }
      }
      const missingFiles = missingFilesFromDB.filter(
        (file) => !excludedByFormat.includes(file),
      );

      const createdFiles = await Promise.all(
        createdStats.map((stats) => pathToIFile(stats, location, this.rootStore.imageLoader)),
      );
      // Find matches between removed and created images (different name/path but same characteristics)
      const createdMatches = missingFiles.map((mf) =>
        createdFiles.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
      );
      // Also look for duplicate files: when a files is renamed/moved it will become a new entry, should be de-duplicated
      const dbMatches = new Map<ID, FileDTO>(await this.backend.findMissingDBMatches(missingFiles));

      console.debug({ missingFiles, createdFiles, createdMatches, dbMatches });

      const foundCreatedMatches = createdMatches.filter((m) => m !== undefined) as FileDTO[];

      runInAction(() => {
        if (
          missingFiles.length - dbMatches.size - foundCreatedMatches.length >
          this.rootStore.fileStore.numMissingFiles
        ) {
          this.rootStore.fileStore.setDirtyMissingFiles(true);
        }
      });

      // Update renamed files in backend
      const updatedFileIds = new Set<ID>();
      if (foundCreatedMatches.length > 0) {
        console.debug(
          `Found ${foundCreatedMatches.length} renamed/moved files in location ${location.name}. These are detected as new files, but will instead replace their original entry in the DB of Allusion`,
          foundCreatedMatches,
        );
        // TODO: remove thumbnail as well (clean-up needed, since the path changed)
        const renamedFilesToUpdate: FileDTO[] = [];
        for (let i = 0; i < createdMatches.length; i++) {
          const match = createdMatches[i];
          if (match) {
            const updatedFileData = {
              ...missingFiles[i],
              absolutePath: match.absolutePath,
              relativePath: match.relativePath,
              name: match.name,
            };
            renamedFilesToUpdate.push(updatedFileData);
            updatedFileIds.add(updatedFileData.id);
            this.rootStore.fileStore.replaceMovedFile(updatedFileData.id, updatedFileData);
          }
        }
        // There might be duplicates, so convert to set
        await this.backend.saveFiles(Array.from(new Set(renamedFilesToUpdate)));
        foundNewFiles = true;
      }

      if (dbMatches.size > 0) {
        // Renaming/moving files will be created as new files while the old one sticks around
        // In here we transfer the tag data over from the old entry to the new one, and delete the old entry
        console.debug(
          `Found ${dbMatches.size} renamed/moved files in location ${location.name} that were already present in the database. Removing duplicates`,
          dbMatches,
        );
        const files: FileDTO[] = [];
        for (let i = 0; i < missingFiles.length; i++) {
          const missingfile = missingFiles[i];
          const match = dbMatches.get(missingfile.id);
          if (match && !updatedFileIds.has(missingfile.id)) {
            files.push({
              ...match,
              tags: Array.from(new Set([...missingfile.tags, ...match.tags])),
              extraProperties: { ...missingfile.extraProperties, ...match.extraProperties },
            });
          }
        }
        // Transfer over tag data on the matched files
        await this.backend.saveFiles(Array.from(new Set(files)));
        // Remove missing files that have a match in the database
        await this.backend.removeFiles(
          missingFiles.filter((mf) => Boolean(dbMatches.get(mf.id))).map((mf) => mf.id),
        );
        foundNewFiles = true; // Set a flag to trigger a refetch
      }

      // For createdFiles without a match, insert them in the DB as new files
      const newFiles = createdFiles.filter((cf) => !foundCreatedMatches.includes(cf));
      if (newFiles.length) {
        await this.backend.createFilesFromPath(location.path, newFiles);
      }

      // Check adn update all metadata in files that have changed on disk
      await batchReducer(
        makeFileBatchFetcher(this.backend, 1000, {
          conjunction: 'and',
          children: [
            { key: 'locationId', operator: 'equals', value: location.id, valueType: 'string' },
          ],
        }),
        async (batch) => {
          await this.updateChangedFiles(batch, diskFileMap);
          return undefined;
        },
        undefined,
      );

      if (!wasInitialized) {
        console.groupEnd();
      }

      foundNewFiles = foundNewFiles || newFiles.length > 0; /**/
      console.groupEnd();
    }

    if (foundNewFiles) {
      AppToaster.show({ message: 'New images detected.', timeout: 5000 }, 'new-images');
    } else {
      this.showLocationProcessToast('hide', 'update');
    }
    this.rootStore.fileStore.refetchFileCounts();
    return foundNewFiles;
  }

  @action async updateChangedFiles(
    dbFiles: FileDTO[],
    diskFileMap: Map<string, FileStats>,
  ): Promise<void> {
    // Also update files that have changed, e.g. when overwriting a file (with same filename)
    // --> update metadata (resolution, size) and recreate thumbnail
    // This can be accomplished by comparing the dateLastIndexed of the file in DB to dateModified of the file on disk
    const updatedFiles: FileDTO[] = [];
    const thumbnailDirectory = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
    for (const dbFile of dbFiles) {
      const diskFile = diskFileMap.get(dbFile.absolutePath);
      if (
        diskFile &&
        (((dbFile.dateLastIndexed.getTime() < diskFile.dateModified.getTime() ||
          dbFile.dateModifiedOS.getTime() !== diskFile.dateModified.getTime()) &&
          diskFile.size !== dbFile.size) ||
          diskFile.ino !== dbFile.ino)
      ) {
        const newFile: FileDTO = {
          ...dbFile,
          // Recreate metadata which checks the resolution of the image
          ...(await getMetaData(diskFile, this.rootStore.imageLoader)),
          ino: diskFile.ino,
          dateModifiedOS: diskFile.dateModified,
          dateLastIndexed: new Date(),
        };

        console.debug(
          `Updating modified file: ${JSON.stringify(
            {
              ino: dbFile.ino,
              size: dbFile.size,
              OrigDateModified: dbFile.dateModifiedOS,
              dateLastIndexed: dbFile.dateLastIndexed,
              name: dbFile.absolutePath,
            },
            null,
            2,
          )} to ${JSON.stringify(
            {
              ino: newFile.ino,
              size: newFile.size,
              OrigDateModified: newFile.dateModifiedOS,
              dateLastIndexed: newFile.dateLastIndexed,
              name: newFile.absolutePath,
            },
            null,
            2,
          )}`,
        );

        updatedFiles.push(newFile);

        // Delete thumbnail if size has changed, will be re-created automatically when needed
        const thumbPath = getThumbnailPath(dbFile.absolutePath, thumbnailDirectory);
        await fse.remove(thumbPath).catch(console.error);
        this.rootStore.fileStore.get(newFile.id)?.setThumbnailPath(thumbPath);
      }
    }
    if (updatedFiles.length > 0) {
      console.debug('Re-indexed files changed on disk', updatedFiles);
      await this.backend.saveFiles(updatedFiles);
    }
  }

  @action get(locationId: ID): ClientLocation | undefined {
    return this.locationList.find((loc) => loc.id === locationId);
  }

  getTags(ids: ID[]): Set<ClientTag> {
    return this.rootStore.tagStore.getTags(ids);
  }

  getLocationTag(location: ClientLocation): ClientTag | undefined;
  getLocationTag(location: ClientSubLocation): ClientTag | undefined;
  getLocationTag(location: { id: ID }): ClientTag | undefined;
  getLocationTag(locaiton: { id: ID }): ClientTag | undefined {
    return this.rootStore.tagStore.get(locaiton.id);
  }

  refreshLocationTags(locaitons: ClientLocation[]): Promise<void> {
    return this.rootStore.tagStore.refreshLocationTags(locaitons);
  }

  @action async changeLocationPath(location: ClientLocation, newPath: string): Promise<void> {
    const index = this.locationList.findIndex((l) => l.id === location.id);
    if (index === -1) {
      throw new Error(`The location ${location.name} has already been removed.`);
    }
    console.log('changing location path', location, newPath);
    // First, update the absolute path of all files from this location
    const locFiles = await this.findLocationFiles(location.id);
    const files: FileDTO[] = locFiles.map((f) => ({
      ...f,
      absolutePath: SysPath.join(newPath, f.relativePath),
    }));
    await this.backend.saveFiles(files);

    const newLocation = new ClientLocation(
      this,
      location.id,
      newPath,
      location.dateAdded,
      location.subLocations.map((sl) => sl.serialize()),
      Array.from(location.tags, (t) => t.id),
      runInAction(() => this.blockedExtensions),
      this.excludeAllExceptIncluded,
      runInAction(() => this.includedExtensions),
      this.locationList.length,
      location.isWatchingFiles,
    );
    runInAction(() => (this.locationList[index] = newLocation));
    await this.initLocation(newLocation);
    await this.backend.saveLocation(newLocation.serialize());
    // Refetch files in case some were from this location and could not be found before
    this.rootStore.fileStore.refetch();

    // Dismiss the 'Cannot find location' toast if it is still open
    AppToaster.dismiss(`missing-loc-${newLocation.id}`);
  }

  @action exists(predicate: (location: ClientLocation) => boolean): boolean {
    return this.locationList.some(predicate);
  }

  @action.bound async create(path: string): Promise<ClientLocation> {
    const location = new ClientLocation(
      this,
      generateId(),
      path,
      new Date(),
      [],
      [],
      runInAction(() => this.blockedExtensions),
      this.excludeAllExceptIncluded,
      runInAction(() => this.includedExtensions),
      this.locationList.length,
      true,
    );
    await this.backend.createLocation(location.serialize());
    runInAction(() => this.locationList.push(location));
    return location;
  }

  /** Imports all files from a location into the FileStore */
  @action.bound async initLocation(location: ClientLocation): Promise<void> {
    const toastKey = `initialize-${location.id}`;

    let isCancelled = false;
    const handleCancelled = () => {
      console.debug('Aborting location initialization', location.name);
      isCancelled = true;
      location.delete();
    };

    AppToaster.show(
      {
        message: 'Finding all images...',
        timeout: 0,
        clickAction: {
          label: 'Cancel',
          onClick: handleCancelled,
        },
      },
      toastKey,
    );

    await location.init();
    const [filePaths] = await location.getDiskFilesAndDirectories();
    location.watch();

    if (isCancelled || filePaths === undefined) {
      return;
    }

    const showProgressToaster = (progress: number) =>
      !isCancelled &&
      AppToaster.show(
        {
          // message: 'Gathering image metadata...',
          message: `Loading ${(progress * 100).toFixed(1)}%...`,
          timeout: 0,
        },
        toastKey,
      );

    showProgressToaster(0);

    // Load file meta info, with only N jobs in parallel and a progress + cancel callback
    // TODO: Should make N configurable, or determine based on the system/disk performance
    const N = 50;
    const files = await promiseAllLimit(
      filePaths.map((path) => () => pathToIFile(path, location, this.rootStore.imageLoader)),
      N,
      showProgressToaster,
      () => isCancelled,
    );

    AppToaster.show({ message: 'Updating database...', timeout: 0 }, toastKey);
    await this.backend.createFilesFromPath(location.path, files);

    AppToaster.show({ message: `Location "${location.name}" is ready!`, timeout: 5000 }, toastKey);
    this.rootStore.fileStore.refetch();
    this.rootStore.fileStore.refetchFileCounts();
  }

  @action.bound async delete(location: ClientLocation): Promise<void> {
    // Remove location from DB through backend
    await this.backend.removeLocation(location.id);
    runInAction(() => {
      // Remove deleted files from selection
      for (const file of this.rootStore.uiStore.fileSelection) {
        if (file.locationId === location.id) {
          this.rootStore.uiStore.deselectFile(file);
        }
      }
      // Remove location locally
      this.locationList.remove(location);
    });
    this.rootStore.fileStore.refetch();
    this.rootStore.fileStore.refetchFileCounts();
  }

  /** Extensions the user has explicitly blocked from indexing. */
  get blockedExtensions(): string[] {
    return this.managedExtensions.filter((m) => m.blocked).map((m) => m.extension);
  }

  /** Extensions explicitly allowed when whitelist mode is enabled. */
  get includedExtensions(): string[] {
    return this.managedExtensions.filter((m) => !m.blocked).map((m) => m.extension);
  }

  @action.bound setExcludeAllExceptIncluded(enabled: boolean): void {
    this.excludeAllExceptIncluded = enabled;
  }

  /** Adds a new managed extension (indexed by default). No-op for blanks/duplicates. */
  @action.bound addManagedExtension(extension: string): void {
    const normalized = extension.trim().toLowerCase().replace(/^\.+/, '');
    if (normalized === '' || this.managedExtensions.some((m) => m.extension === normalized)) {
      return;
    }
    this.managedExtensions.push({ extension: normalized, blocked: false });
  }

  /** Toggles whether a managed extension is blocked from indexing. */
  @action.bound toggleManagedExtension(extension: string): void {
    const entry = this.managedExtensions.find((m) => m.extension === extension);
    if (entry) {
      entry.blocked = !entry.blocked;
    }
  }

  /** Removes a managed extension entry, reverting it to the default (indexed). */
  @action.bound removeManagedExtension(extension: string): void {
    const idx = this.managedExtensions.findIndex((m) => m.extension === extension);
    if (idx !== -1) {
      this.managedExtensions.splice(idx, 1);
    }
  }

  /** Persists the managed extensions and pushes the blocked set to every location. */
  @action.bound async saveManagedExtensions(removeBlockedFiles: boolean = true): Promise<void> {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        managedExtensions: this.managedExtensions.slice(),
        excludeAllExceptIncluded: this.excludeAllExceptIncluded,
      } as Preferences, null, 2),
    );
    const blocked = this.blockedExtensions;
    for (const location of this.locationList) {
      await location.updateBlockedExtensions(
        blocked,
        this.excludeAllExceptIncluded,
        this.includedExtensions,
      );
    }

    if (removeBlockedFiles && blocked.length > 0) {
      for (const extension of blocked) {
        await this.rootStore.fileStore.deleteFilesByExtension(extension);
      }
    }

    // Newly included formats are picked up by a normal Location refresh.
    await this.updateLocations();
  }

  @action async addFile(fileStats: FileStats, location: ClientLocation): Promise<void> {
    const fileStore = this.rootStore.fileStore;

    // Gather file data
    const file = await pathToIFile(fileStats, location, this.rootStore.imageLoader);

    // Check if file is being moved/renamed (which is detected as a "add" event followed by "remove" event)
    const match = runInAction(() => fileStore.fileList.find((f) => f && f.ino === fileStats.ino));
    const dbMatch = match
      ? undefined
      : (await this.backend.fetchFilesByKey('ino', fileStats.ino))[0];
    const dbMatchOverwrite = match
      ? undefined
      : (await this.backend.fetchFilesByKey('absolutePath', fileStats.absolutePath))[0];

    if (match) {
      if (fileStats.absolutePath === match.absolutePath) {
        fileStore.debouncedRefetch();
        return;
      }
      fileStore.replaceMovedFile(match, file);
    } else if (dbMatch) {
      runInAction(() => {
        const newIFile = mergeMovedFile(dbMatch, file);
        const newClientfile = new ClientFile(this.rootStore.fileStore, newIFile);
        this.rootStore.fileStore.save(newClientfile.serialize());
        newClientfile.dispose();
      });
    } else if (dbMatchOverwrite) {
      await this.updateChangedFiles(
        [dbMatchOverwrite],
        new Map<string, FileStats>([[fileStats.absolutePath, fileStats]]),
      );
    } else {
      await this.backend.createFilesFromPath(fileStats.absolutePath, [file]);
      fileStore.setDirtyTotalFiles(true);
      fileStore.setDirtyUntaggedFiles(true);
      if (this.rootStore.uiStore.isNotifyOnNewFilesEnabled) {
        // The file is already in the DB; defer the (potentially expensive) gallery
        // refetch and let the user refresh when they choose via the notification.
        this.notifyPendingNewFile();
        return;
      }
      AppToaster.show({ message: 'New images have been detected.', timeout: 5000 }, 'new-images');
      // might be called a lot when moving many images into a folder, so debounce it
    }
    fileStore.debouncedRefetch();
  }

  updateFile(file: FileStats): void {
    this.filesToUpdate.set(file.absolutePath, file);
    // Debouncing the file update action improves performance when bulk writing file metadata.
    this.debouncedUpdateFilesToUpdate();
  }

  @action async updateFilestoUpdate(): Promise<void> {
    const fileStats = Array.from(this.filesToUpdate.values());
    this.filesToUpdate.clear();
    const fileStore = this.rootStore.fileStore;
    const dbMatchOverwrites = await this.backend.fetchFilesByKey(
      'absolutePath',
      fileStats.map((fs) => fs.absolutePath),
    );
    if (dbMatchOverwrites.length > 0) {
      await this.updateChangedFiles(
        dbMatchOverwrites,
        new Map<string, FileStats>(fileStats.map((fs) => [fs.absolutePath, fs])),
      );
      // Do a refetch except if inside slide mode to avoid to exit it.
      if (runInAction(() => !this.rootStore.uiStore.isSlideMode)) {
        fileStore.debouncedRefetch();
      }
    }
  }

  @action async hideFile(path: string): Promise<void> {
    // This is called when an image is removed from the filesystem.
    // Could also mean that a file was renamed or moved, in which case addFile was called already:
    // its path will have changed, so we won't find it here, which is fine, it'll be detected as missing later.
    const fileStore = this.rootStore.fileStore;
    const clientFile = fileStore.fileList.find((f) => f && f.absolutePath === path);

    if (clientFile) {
      fileStore.hideFile(clientFile);
      fileStore.debouncedRefetch();
    } else {
      // If the hidden file exists in the DB but not in the current fileList, mark missingFilesCount as dirty.
      const dbMatch = (await this.backend.fetchFilesByKey('absolutePath', path))[0];
      if (dbMatch) {
        fileStore.setDirtyMissingFiles(true);
      }
    }
  }

  /**
   * Fetches the files belonging to a location
   */
  @action async findLocationFiles(locationId: ID): Promise<FileDTO[]> {
    const crit = new ClientStringSearchCriteria(
      undefined,
      'locationId',
      locationId,
      'equals',
    ).toCondition();
    return this.backend.searchFiles(
      { conjunction: 'and', children: [crit] },
      'id',
      OrderDirection.Asc,
      false,
    );
  }

  @action async removeSublocationFiles(subLoc: ClientSubLocation): Promise<void> {
    const crit = new ClientStringSearchCriteria(
      undefined,
      'absolutePath',
      subLoc.path,
      'startsWith',
    ).toCondition();
    const files = await this.backend.searchFiles(
      { conjunction: 'and', children: [crit] },
      'id',
      OrderDirection.Asc,
      false,
    );
    await this.backend.removeFiles(files.map((f) => f.id));
    this.rootStore.fileStore.refetch();
  }

  /**
   * Excludes a file (or its parent folder) from Allusion without deleting it from disk.
   *
   * This does two things:
   * 1. Appends the path to the location's .allusionignore file so it is
   *    never re-indexed on future scans or folder watcher events.
   * 2. Removes the file(s) from the Allusion database immediately.
   *
   * Called from the right-click context menu "Exclude from Allusion" submenu.
   */
  @action async excludeFromAllusion(file: ClientFile, excludeParentFolder: boolean): Promise<void> {
    const location = this.locationList.find((l) => l.id === file.locationId);
    if (!location) {
      console.error('excludeFromAllusion: could not find location for file', file.absolutePath);
      return;
    }

    const targetPath = excludeParentFolder
      ? SysPath.dirname(file.absolutePath)
      : file.absolutePath;

    try {
      // 1. Write the path to .allusionignore
      await appendToIgnoreList(location.path, targetPath, excludeParentFolder);

      if (excludeParentFolder) {
        // 2a. Remove all files in the folder from the DB (without touching disk)
        const crit = new ClientStringSearchCriteria(
          undefined,
          'absolutePath',
          targetPath + SysPath.sep,
          'startsWith',
        ).toCondition();
        const files = await this.backend.searchFiles(
          { conjunction: 'and', children: [crit] },
          'id',
          OrderDirection.Asc,
          false,
        );
        await this.backend.removeFiles(files.map((f) => f.id));
        this.rootStore.fileStore.refetch();
      } else {
        // 2b. Remove just this one file from the DB (without touching disk)
        const clientFile = this.rootStore.fileStore.get(file.id);
        if (clientFile) {
          await this.rootStore.fileStore.deleteFiles([clientFile]);
        }
      }

      // 3. Reload the ignore list so the watcher and future scans respect the new entry immediately
      await location.reloadIgnoreList();

      AppToaster.show({
        message: excludeParentFolder
          ? `Folder "${SysPath.basename(targetPath)}" excluded from Allusion`
          : `File "${file.name}" excluded from Allusion`,
        timeout: 3000,
      });
    } catch (err) {
      console.error('excludeFromAllusion: failed', err);
      AppToaster.show({
        message: 'Could not exclude from Allusion. Check the console for details.',
        timeout: 5000,
        type: 'warning',
      });
    }
  }

  /** Source is moved to where Target currently is */
  @action.bound reorder(source: ClientLocation, target: ClientLocation): void {
    const sourceIndex = this.locationList.indexOf(source);
    const targetIndex = this.locationList.indexOf(target);

    // Remove the source element and insert it at the target index
    this.locationList.remove(source);
    this.locationList.splice(targetIndex, 0, source);

    // Update the index for all changed items: all items between source and target have been moved
    const startIndex = Math.min(sourceIndex, targetIndex);
    const endIndex = Math.max(sourceIndex, targetIndex);
    for (let i = startIndex; i <= endIndex; i++) {
      this.locationList[i].setIndex(i);
      this.save(this.locationList[i].serialize());
    }
  }

  // Close and save snapshots for all watcher workers
  @action async close(): Promise<void> {
    for (const location of this.locationList.slice()) {
      await location.close();
    }
  }
}

export async function pathToIFile(
  stats: FileStats,
  loc: ClientLocation,
  imageLoader: ImageLoader,
): Promise<FileDTO> {
  const now = new Date();
  return {
    absolutePath: stats.absolutePath,
    relativePath: stats.absolutePath.replace(loc.path, ''),
    ino: stats.ino,
    id: generateId(),
    locationId: loc.id,
    tags: [],
    tagSorting: 'hierarchy',
    extraProperties: {},
    dateAdded: now,
    dateModified: now,
    dateModifiedOS: stats.dateModified,
    dateLastIndexed: now,
    ...(await getMetaData(stats, imageLoader)),
  };
}

export default LocationStore;
