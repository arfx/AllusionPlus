import { Remote, wrap } from 'comlink';
import fse from 'fs-extra';
import {
  IObservableArray,
  ObservableSet,
  action,
  makeObservable,
  observable,
  runInAction,
} from 'mobx';
import SysPath from 'path';

import { retainArray } from 'common/core';
import { FileStats } from '../../api/file';
import { generateId, ID } from '../../api/id';
import { LocationDTO, SubLocationDTO } from '../../api/location';
import { RendererMessenger } from '../../ipc/renderer';
import { AppToaster } from '../components/Toaster';
import LocationStore from '../stores/LocationStore';
import { readIgnoreList, isPathIgnored } from '../stores/ignoreList';
import { FolderWatcherWorker } from '../workers/folderWatcher.worker';
import { ClientTag } from './Tag';

/** Sorts alphanumerically, "natural" sort */
const sort = (a: SubLocationDTO | ClientSubLocation, b: SubLocationDTO | ClientSubLocation) =>
  a.path.localeCompare(b.path, undefined, { numeric: true });

export class ClientSubLocation {
  id: ID;
  path: string;
  location: ClientLocation;
  @observable
  isExcluded: boolean;
  readonly subLocations: IObservableArray<ClientSubLocation>;
  readonly tags: ObservableSet<ClientTag>;
  locationTag: ClientTag | undefined;

  constructor(
    store: LocationStore,
    location: ClientLocation,
    path: string,
    id: ID,
    excluded: boolean,
    subLocations: SubLocationDTO[],
    tags: ID[],
  ) {
    this.id = id;
    this.path = path;
    this.location = location;
    this.isExcluded = excluded;
    this.subLocations = observable(
      subLocations
        .sort(sort)
        .map(
          (subLoc) =>
            new ClientSubLocation(
              store,
              this.location,
              subLoc.path,
              subLoc.id,
              subLoc.isExcluded,
              subLoc.subLocations,
              subLoc.tags,
            ),
        ),
    );
    this.tags = observable(store.getTags(tags));
    this.locationTag = store.getLocationTag({ id });

    makeObservable(this);
  }

  get name(): string {
    return SysPath.basename(this.path);
  }

  @action.bound
  toggleExcluded = (): void => {
    this.isExcluded = !this.isExcluded;
    this.location.updateSublocationExclusion(this);
  };

  @action.bound
  addTags(tags: ClientTag | ClientTag[]): void {
    tags = Array.isArray(tags) ? tags : [tags];
    for (const tag of tags) {
      this.tags.add(tag);
      this.locationTag?.addImpliedTag(tag);
    }
    this.location.save();
  }

  @action.bound
  removeTags(tags: ClientTag | ClientTag[]): void {
    tags = Array.isArray(tags) ? tags : [tags];
    for (const tag of tags) {
      this.tags.delete(tag);
      this.locationTag?.removeImpliedTag(tag);
    }
    this.location.save();
  }

  @action.bound
  clearTags(): void {
    this.tags.clear();
    this.locationTag?.replaceImpliedTags([]);
    this.location.save();
  }

  @action.bound
  serialize(): SubLocationDTO {
    return {
      id: this.id,
      path: this.path.toString(),
      isExcluded: Boolean(this.isExcluded),
      subLocations: this.subLocations.map((subLoc) => subLoc.serialize()),
      tags: Array.from(this.tags, (t) => t.id),
    };
  }
}

export class ClientLocation {
  private store: LocationStore;

  worker?: Remote<FolderWatcherWorker>;
  _worker?: Worker;

  @observable isSettingWatcher;
  @observable isInitialized = false;
  @observable isRefreshing = false;
  @observable isBroken = false;
  @observable isWatchingFiles: boolean;

  index: number;

  /**
   * Extensions that the user has blocked from indexing.
   * Files with these extensions are skipped during scan and live watching.
   * Everything else is indexed regardless of extension.
   */
  blockedExtensions: Set<string>;
  excludeAllExceptIncluded: boolean;
  includedExtensions: Set<string>;

  /** Absolute paths loaded from .allusionignore — files and folders to skip during indexing */
  ignoredPaths: string[] = [];

  readonly subLocations: IObservableArray<ClientSubLocation>;
  readonly tags: ObservableSet<ClientTag>;
  locationTag: ClientTag | undefined;
  protected readonly excludedPaths: ClientSubLocation[] = [];

  readonly id: ID;
  readonly path: string;
  readonly dateAdded: Date;

  constructor(
    store: LocationStore,
    id: ID,
    path: string,
    dateAdded: Date,
    subLocations: SubLocationDTO[],
    tags: ID[],
    blockedExtensions: string[],
    excludeAllExceptIncluded: boolean,
    includedExtensions: string[],
    index: number,
    isWatchingFiles: boolean,
  ) {
    this.store = store;
    this.id = id;
    this.path = path;
    this.dateAdded = dateAdded;
    this.blockedExtensions = new Set(blockedExtensions);
    this.excludeAllExceptIncluded = excludeAllExceptIncluded;
    this.includedExtensions = new Set(includedExtensions);
    this.index = index;
    this.isWatchingFiles = isWatchingFiles;
    this.isSettingWatcher = isWatchingFiles;

    this.subLocations = observable(
      subLocations
        .sort(sort)
        .map(
          (subLoc) =>
            new ClientSubLocation(
              this.store,
              this,
              subLoc.path,
              subLoc.id,
              subLoc.isExcluded,
              subLoc.subLocations,
              subLoc.tags,
            ),
        ),
    );
    this.tags = observable(this.store.getTags(tags));
    this.locationTag = store.getLocationTag({ id });

    makeObservable(this);
  }

  get name(): string {
    return SysPath.basename(this.path);
  }

  @action async init(): Promise<void> {
    if (this.isInitialized === true) {
      return;
    }

    if (this.isWatchingFiles) {
      await this.refreshSublocations();
    }

    // Load .allusionignore for this location before scanning or watching
    this.ignoredPaths = await readIgnoreList(this.path);
    if (this.ignoredPaths.length > 0) {
      console.debug(`[${this.name}] Loaded ${this.ignoredPaths.length} ignore rule(s) from .allusionignore`);
    }

    runInAction(() => {
      this.isInitialized = true;
      function* getExcludedSubLocsRecursively(
        subLocations: ClientSubLocation[],
      ): Generator<ClientSubLocation> {
        for (const s of subLocations) {
          if (s.isExcluded) {
            yield s;
          } else {
            yield* getExcludedSubLocsRecursively(s.subLocations);
          }
        }
      }
      this.excludedPaths.splice(0, this.excludedPaths.length);
      this.excludedPaths.push(...getExcludedSubLocsRecursively(this.subLocations));
    });

    this.store.refreshLocationTags([this]);
    if (await fse.pathExists(this.path)) {
      this.setBroken(false);
    } else {
      this.setBroken(true);
    }
  }

  async reloadIgnoreList(): Promise<void> {
    this.ignoredPaths = await readIgnoreList(this.path);
    console.debug(`[${this.name}] Reloaded ignore list: ${this.ignoredPaths.length} rule(s)`);
  }

  /**
   * Updates the blocked extension set when the user changes their preferences.
   * Called by LocationStore after saving managed extensions.
   */
  async updateBlockedExtensions(
    blockedExtensions: string[],
    excludeAllExceptIncluded: boolean,
    includedExtensions: string[],
  ): Promise<void> {
    this.blockedExtensions = new Set(blockedExtensions);
    this.excludeAllExceptIncluded = excludeAllExceptIncluded;
    this.includedExtensions = new Set(includedExtensions);
    await this.worker?.updateBlockedExtensions(
      blockedExtensions,
      excludeAllExceptIncluded,
      includedExtensions,
    );
  }

  @action setBroken(state: boolean): void {
    this.isBroken = state;
  }

  @action setSettingWatcher(state: boolean): void {
    this.isSettingWatcher = state;
  }

  @action.bound async toggleWatchFiles(): Promise<void> {
    if (this.isWatchingFiles) {
      if (this.worker !== undefined) {
        await this.worker.cancel();
        await this.worker.close();
        this.worker = undefined;
        this.isWatchingFiles = false;
      }
    } else {
      if (this.worker === undefined) {
        this.isWatchingFiles = true;
        this.store.watchLocations(this);
      }
    }
    this.store.save(this.serialize());
  }

  async delete(): Promise<void> {
    this.worker?.cancel();
    await this.drop();
    return this.store.delete(this);
  }

  async updateSublocationExclusion(subLocation: ClientSubLocation): Promise<void> {
    if (subLocation.isExcluded) {
      if (!this.excludedPaths.includes(subLocation)) {
        this.excludedPaths.push(subLocation);
      }
      if (this.isInitialized) {
        await this.store.removeSublocationFiles(subLocation);
      }
    } else {
      const index = this.excludedPaths.findIndex((l) => l === subLocation);
      if (index !== -1) {
        this.excludedPaths.splice(index, 1);
      }
      if (this.isInitialized) {
        AppToaster.show({
          message: 'Restart Allusion to re-detect any images',
          timeout: 8000,
          clickAction: {
            onClick: RendererMessenger.reload,
            label: 'Restart',
          },
        });
      }
    }
    this.save();
  }

  @action.bound
  addTags(tags: ClientTag | ClientTag[]): void {
    tags = Array.isArray(tags) ? tags : [tags];
    for (const tag of tags) {
      this.tags.add(tag);
      this.locationTag?.addImpliedTag(tag);
    }
    this.save();
  }

  @action.bound
  removeTags(tags: ClientTag | ClientTag[]): void {
    tags = Array.isArray(tags) ? tags : [tags];
    for (const tag of tags) {
      this.tags.delete(tag);
      this.locationTag?.removeImpliedTag(tag);
    }
    this.save();
  }

  @action.bound
  clearTags(): void {
    this.tags.clear();
    this.locationTag?.replaceImpliedTags([]);
    this.save();
  }

  @action.bound
  save(): void {
    this.store.save(this.serialize());
  }

  @action.bound
  serialize(): LocationDTO {
    return {
      id: this.id,
      path: this.path,
      dateAdded: this.dateAdded,
      subLocations: this.subLocations.map((sl) => sl.serialize()),
      tags: Array.from(this.tags, (t) => t.id),
      index: this.index,
      isWatchingFiles: this.isWatchingFiles,
    };
  }

  @action.bound setIndex(index: number): void {
    this.index = index;
  }

  async drop(): Promise<void> {
    return this.worker?.close();
  }

  @action async refreshSublocations(rootDirectoryItem?: IDirectoryTreeItem): Promise<void> {
    this.isRefreshing = true;

    let rootItem;
    if (rootDirectoryItem === undefined) {
      const directoryTree = await getDirectoryTree(this.path);
      rootItem = {
        name: 'root',
        fullPath: this.path,
        children: directoryTree,
      };
    } else {
      rootItem = rootDirectoryItem;
    }

    const updateSubLocations = action(
      (loc: ClientLocation | ClientSubLocation, dir: IDirectoryTreeItem) => {
        const newSublocations: ClientSubLocation[] = [];
        for (const item of dir.children) {
          const subLoc =
            loc.subLocations.find((subLoc) => subLoc.path === item.fullPath) ??
            new ClientSubLocation(
              this.store,
              this,
              item.fullPath,
              generateId(),
              item.name.startsWith('.'),
              [],
              [],
            );
          newSublocations.push(subLoc);
          if (item.children.length > 0) {
            updateSubLocations(subLoc, item);
          } else {
            subLoc.subLocations.clear();
          }
        }
        loc.subLocations.replace(newSublocations.sort(sort));
        this.isRefreshing = false;
      },
    );

    updateSubLocations(this, rootItem);
    this.store.save(this.serialize());
  }

  @action async getDiskFilesAndDirectories(): Promise<
    [FileStats[], IDirectoryTreeItem | undefined] | [undefined, undefined]
  > {
    if (this.isBroken) {
      console.error(
        'Location error:',
        'Cannot get disk files from a location because it is broken or not initialized.',
      );
      return [undefined, undefined];
    }

    const directory = this.path.replace(/\\/g, '/');

    /**
     * Determines whether a file or directory should be skipped.
     * Under the new "index everything" model:
     * - dot-prefixed names are always skipped (hidden / system files)
     * - .allusionignore entries are skipped
     * - files with a user-blocked extension are skipped
     * - everything else is included, regardless of extension
     */
    const shouldIgnore = (filePath: string, dirent?: fse.Dirent): boolean => {
      const basename = SysPath.basename(filePath);

      // Skip hidden/system files and folders
      if (basename.startsWith('.')) return true;

      // Skip .allusionignore entries
      if (isPathIgnored(filePath, this.ignoredPaths)) return true;

      // Directories remain traversable; format rules apply only to files.
      if (dirent?.isDirectory()) return false;

      const ext = SysPath.extname(filePath).toLowerCase().slice(1);
      if (ext && this.blockedExtensions.has(ext)) return true;
      if (this.excludeAllExceptIncluded && (!ext || !this.includedExtensions.has(ext))) return true;
      return false;
    };

    const getAllFilesRecursive = async (
      dir: string,
    ): Promise<[FileStats[], IDirectoryTreeItem[]]> => {
      const dirents = await fse.readdir(dir, { withFileTypes: true });
      const filesDirectoriesPairs: [FileStats[], IDirectoryTreeItem[]][] = await Promise.all(
        dirents.map(async (dirent) => {
          const absolutePath = SysPath.join(dir, dirent.name);
          if (shouldIgnore(absolutePath, dirent)) {
            return [[], []];
          }
          if (dirent.isDirectory()) {
            const [files, directories] = await getAllFilesRecursive(absolutePath);
            return [
              files,
              [
                {
                  name: SysPath.basename(absolutePath),
                  fullPath: absolutePath,
                  children: directories,
                },
              ],
            ];
          } else {
            const stats = await fse.stat(absolutePath);
            return [
              [
                {
                  absolutePath,
                  dateCreated: stats.birthtime,
                  dateModified: stats.mtime,
                  size: Number(stats.size),
                  ino: stats.ino.toString(),
                },
              ],
              [],
            ];
          }
        }),
      );

      const flatFiles: FileStats[] = [];
      const flatDirs: IDirectoryTreeItem[] = [];
      for (const [files, dirs] of filesDirectoriesPairs) {
        flatFiles.push(...files);
        flatDirs.push(...dirs);
      }
      return [flatFiles, flatDirs];
    };

    const [diskFiles, directoryTree] = await getAllFilesRecursive(directory);
    const rootItem = {
      name: 'root',
      fullPath: this.path,
      children: directoryTree,
    };

    const filteredDiskFiles = diskFiles.filter(
      ({ absolutePath }) =>
        !this.excludedPaths.some((subLoc) => absolutePath.startsWith(subLoc.path)) &&
        !isPathIgnored(absolutePath, this.ignoredPaths),
    );
    return [filteredDiskFiles, rootItem];
  }

  @action async watch(): Promise<boolean> {
    if (this.isBroken) {
      console.error(
        'Location watch error:',
        'Cannot watch a location because it is broken or not initialized.',
      );
      return false;
    }
    this.setSettingWatcher(true);
    const directory = this.path;
    console.debug('Loading folder watcher worker...', directory);
    const worker = new Worker(
      new URL('src/frontend/workers/folderWatcher.worker', import.meta.url),
    );
    worker.onmessage = ({
      data,
    }: {
      data:
        | { type: 'remove' | 'error'; value: string }
        | { type: 'add'; value: FileStats }
        | { type: 'update'; value: FileStats };
    }) => {
      if (data.type === 'add') {
        const { absolutePath } = data.value;
        if (this.excludedPaths.some((subLoc) => absolutePath.startsWith(subLoc.path))) {
          console.debug('File added to excluded sublocation', absolutePath);
        } else if (isPathIgnored(absolutePath, this.ignoredPaths)) {
          console.debug('File ignored by .allusionignore', absolutePath);
        } else {
          console.log(`File ${absolutePath} has been added after initialization`);
          this.store.addFile(data.value, this);
        }
      } else if (data.type === 'update') {
        setTimeout(async () => {
          const updatesStats = await fse.stat(data.value.absolutePath);
          data.value.dateModified = updatesStats.mtime;
          this.store.updateFile(data.value);
        }, 500);
      } else if (data.type === 'remove') {
        const { value } = data;
        console.log(`Location "${this.name}": File ${value} has been removed.`);
        this.store.hideFile(value);
      } else if (data.type === 'error') {
        const { value } = data;
        console.error('Location watch error:', value);
        if (value === 'ENOENT') {
          AppToaster.show(
            {
              message: `An error has occurred while reading a new file at location "${this.name}".`,
              timeout: 3000,
              type: 'warning',
            },
            'location-error',
          );
          return;
        }
        AppToaster.show(
          {
            message: `An error has occured while ${
              this.isSettingWatcher ? 'watching' : 'initializing watch'
            } location "${this.name}".`,
            timeout: 0,
          },
          'location-error',
        );
      }
    };

    const WorkerFactory = wrap<typeof FolderWatcherWorker>(worker);
    this.worker = await new WorkerFactory();
    this._worker?.terminate();
    this._worker = worker;

    await fse.ensureDir(this.store.watcherSnapshotDirectory);
    const snapshotFilePath = SysPath.join(
      this.store.watcherSnapshotDirectory,
      `${this.id}.snapshot.json`,
    );
    await this.worker.watch(
      directory,
      Array.from(this.blockedExtensions),
      this.excludeAllExceptIncluded,
      Array.from(this.includedExtensions),
      snapshotFilePath,
      this.store.PARCEL_WATCHER_BACKEND,
      this.ignoredPaths,
    );

    this.setSettingWatcher(false);
    return true;
  }

  @action async close(): Promise<void> {
    await this.worker?.cancel();
    await this.worker?.close();
  }
}

interface IDirectoryTreeItem {
  name: string;
  fullPath: string;
  children: IDirectoryTreeItem[];
}

async function getDirectoryTree(path: string): Promise<IDirectoryTreeItem[]> {
  try {
    const NULL = { name: '', fullPath: '', children: [] };
    const dirs = await Promise.all(
      Array.from(await fse.readdir(path), async (file) => {
        const fullPath = SysPath.join(path, file);
        if ((await fse.stat(fullPath)).isDirectory()) {
          return {
            name: SysPath.basename(fullPath),
            fullPath,
            children: await getDirectoryTree(fullPath),
          };
        } else {
          return NULL;
        }
      }),
    );
    retainArray(dirs, (dir) => dir !== NULL);
    return dirs;
  } catch (e) {
    return [];
  }
}