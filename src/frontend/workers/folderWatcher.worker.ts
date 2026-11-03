import { expose } from 'comlink';
import { statSync } from 'fs';
import SysPath from 'path';
import { FileStats } from 'src/api/file';
import * as parcelWatcher from '@parcel/watcher';

const ctx: Worker = self as any;

export class FolderWatcherWorker {
  private watcher?: parcelWatcher.AsyncSubscription;
  private isCancelled = false;
  private directory?: string;
  private snapshotFilePath?: string;
  private backend?: parcelWatcher.BackendType;
  private blockedExtensions: Set<string> = new Set();
  private excludeAllExceptIncluded = false;
  private includedExtensions: Set<string> = new Set();

  updateBlockedExtensions(
    blockedExtensions: string[],
    excludeAllExceptIncluded: boolean,
    includedExtensions: string[],
  ) {
    this.blockedExtensions = new Set(blockedExtensions);
    this.excludeAllExceptIncluded = excludeAllExceptIncluded;
    this.includedExtensions = new Set(includedExtensions);
  }

  cancel() {
    this.isCancelled = true;
  }

  async close() {
    if (this.watcher) {
      this.watcher.unsubscribe();
      this.watcher = undefined;
    }
    if (this.snapshotFilePath && this.directory) {
      console.debug(`Creating watcher snapshot for ${this.directory}: ${this.snapshotFilePath}`);
      try {
        await parcelWatcher.writeSnapshot(this.directory, this.snapshotFilePath, {
          backend: this.backend,
        });
      } catch (err) {
        console.error(`${this.snapshotFilePath} - Failed writing snapshot on close:`, err);
      }
    }
  }

  /**
   * Watches a directory for file changes. Picks up ALL file types by default.
   * Only skips files whose extension is in the blockedExtensions list.
   */
  async watch(
    directory: string,
    blockedExtensions: string[],
    snapshotFilePath: string,
    backend: parcelWatcher.BackendType,
    excludeAllExceptIncluded: boolean,
    includedExtensions: string[],
    ignorePaths: string[] = [],
  ): Promise<void> {
    this.isCancelled = false;
    this.backend = backend;
    this.blockedExtensions = new Set(blockedExtensions);
    this.excludeAllExceptIncluded = excludeAllExceptIncluded;
    this.includedExtensions = new Set(includedExtensions);

    directory = directory.replace(/\\/g, '/');
    snapshotFilePath = snapshotFilePath.replace(/\\/g, '/');
    this.directory = directory;
    this.snapshotFilePath = snapshotFilePath;

    const handleEvents = async (events: parcelWatcher.Event[]) => {
      for (const event of events) {
        const basename = SysPath.basename(event.path);

        // Skip dot-prefixed files (hidden files / system files)
        if (basename.startsWith('.')) {
          continue;
        }

        if (event.type === 'create' || event.type === 'update') {
          try {
            const stats = statSync(event.path);
            if (stats.isDirectory()) continue;
            const ext = SysPath.extname(event.path).toLowerCase().slice(1);
            if ((ext && this.blockedExtensions.has(ext)) ||
              (this.excludeAllExceptIncluded && (!ext || !this.includedExtensions.has(ext)))) continue;
          } catch (e) {
            continue;
          }
        }

        if (event.type === 'create') {
          if (this.isCancelled) {
            console.log('Cancelling file watching');
            this.watcher?.unsubscribe();
            this.isCancelled = false;
          }
          try {
            const stats = statSync(event.path);
            // Skip directories — we only care about files
            if (stats.isDirectory()) continue;

            const fileStats: FileStats = {
              absolutePath: event.path,
              dateCreated: stats.birthtime,
              dateModified: stats.mtime,
              size: Number(stats.size),
              ino: stats.ino.toString(),
            };
            ctx.postMessage({ type: 'add', value: fileStats });
          } catch (e) {
            // File may have been deleted before we could stat it — ignore
            console.debug('Could not stat created file, skipping:', event.path, e);
          }
        } else if (event.type === 'update') {
          if (this.isCancelled) {
            console.log('Cancelling file watching');
            this.watcher?.unsubscribe();
            this.isCancelled = false;
          }
          try {
            const stats = statSync(event.path);
            if (stats.isDirectory()) continue;

            const fileStats: FileStats = {
              absolutePath: event.path,
              dateCreated: stats.birthtime,
              dateModified: stats.mtime,
              size: Number(stats.size),
              ino: stats.ino.toString(),
            };
            ctx.postMessage({ type: 'update', value: fileStats });
          } catch (e) {
            console.debug('Could not stat updated file, skipping:', event.path, e);
          }
        } else if (event.type === 'delete') {
          ctx.postMessage({ type: 'remove', value: event.path });
        }
      }
    };

    try {
      console.debug('Reading watcher snapshot...', directory);
      const historical = await parcelWatcher.getEventsSince(directory, this.snapshotFilePath, {
        backend: this.backend,
      });
      handleEvents(historical);
    } catch (err) {
      console.warn('No snapshot available, skipping historical events.', err);
    }

    this.watcher = await parcelWatcher.subscribe(
      directory,
      (err, events) => {
        if (err) {
          console.error('Error fired in watcher', directory, err);
          ctx.postMessage({ type: 'error', value: err });
        }
        handleEvents(events).catch((err) => {
          ctx.postMessage({ type: 'error', value: err.code });
        });
      },
      { ignore: ignorePaths, backend: backend },
    );
  }
}

expose(FolderWatcherWorker, self);