import { getThumbnailPath, isDirEmpty } from 'common/fs';
import { thumbnailFormat } from 'common/config';
import fse from 'fs-extra';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useEffect, useState } from 'react';
import FileInput from 'src/frontend/components/FileInput';
import { RendererMessenger } from 'src/ipc/renderer';
import { Button, ButtonGroup, IconSet } from 'widgets';
import { useStore } from '../../contexts/StoreContext';
import { getThumbnailDiagnostics, moveThumbnailDir, resetThumbnailDiagnostics } from '../../image/ThumbnailGeneration';
import { ClearDbButton } from '../ErrorBoundary';
import { Alert, DialogButton } from 'widgets/popovers';
import { Callout } from 'widgets/notifications';
import ExternalLink from 'src/frontend/components/ExternalLink';

type CacheStats = { files: number; bytes: number };

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const Advanced = observer(() => {
  const { uiStore, fileStore } = useStore();
  const thumbnailDirectory = uiStore.thumbnailDirectory;

  const [defaultThumbnailDir, setDefaultThumbnailDir] = useState('');
  const [isClearThumbnailCacheOpen, setIsClearThumbnailCacheOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState(getThumbnailDiagnostics());
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isScanningCache, setIsScanningCache] = useState(false);

  const refreshCacheStats = async () => {
    setIsScanningCache(true);
    try {
      const entries = await fse.readdir(thumbnailDirectory);
      let files = 0;
      let bytes = 0;
      for (const entry of entries) {
        if (entry === 'forged' || !entry.endsWith(`.${thumbnailFormat}`)) continue;
        try {
          const stat = await fse.stat(`${thumbnailDirectory}/${entry}`);
          if (stat.isFile()) {
            files++;
            bytes += stat.size;
          }
        } catch {
          // Ignore files removed while the cache is being scanned.
        }
      }
      setCacheStats({ files, bytes });
    } finally {
      setIsScanningCache(false);
    }
  };

  const clearThumbnailCache = async () => {
    const entries = await fse.readdir(thumbnailDirectory);
    for (const entry of entries) {
      // Custom thumbnails are user-created assets and must always be preserved.
      if (entry === 'forged') continue;
      if (entry.endsWith(`.${thumbnailFormat}`)) {
        await fse.remove(`${thumbnailDirectory}/${entry}`);
      }
    }
    setIsClearThumbnailCacheOpen(false);
    setCacheStats({ files: 0, bytes: 0 });
    // Reinitialize file thumbnail paths and regenerate thumbnails as needed.
    RendererMessenger.reload();
  };

  useEffect(() => {
    RendererMessenger.getDefaultThumbnailDirectory().then(setDefaultThumbnailDir);
    const interval = window.setInterval(() => setDiagnostics(getThumbnailDiagnostics()), 1000);
    refreshCacheStats();
    return () => window.clearInterval(interval);
  }, [thumbnailDirectory]);

  const changeThumbnailDirectory = async (newDir: string) => {
    const oldDir = thumbnailDirectory;

    // Move thumbnail files
    await moveThumbnailDir(oldDir, newDir);
    uiStore.setThumbnailDirectory(newDir);

    // Reset thumbnail paths for those that already have one
    runInAction(() => {
      for (const f of fileStore.fileList) {
        if (f && f.thumbnailPath && f.thumbnailPath !== f.absolutePath) {
          f.setThumbnailPath(getThumbnailPath(f.absolutePath, newDir));
        }
      }
    });
  };

  const browseThumbnailDirectory = async ([newDir]: [string, ...string[]]) => {
    if (!(await isDirEmpty(newDir))) {
      if (
        window.confirm(
          `The directory you picked is not empty. Allusion might delete any files inside of it. Do you still wish to pick this directory?\n\nYou picked: ${newDir}`,
        )
      ) {
        changeThumbnailDirectory(newDir);
      }
    } else {
      changeThumbnailDirectory(newDir);
    }
  };

  const averageDuration = diagnostics.succeeded + diagnostics.failed + diagnostics.deferred > 0
    ? diagnostics.totalDurationMs / (diagnostics.succeeded + diagnostics.failed + diagnostics.deferred)
    : 0;

  return (
    <>
      {/* Todo: Add support to toggle this */}
      {/* <Switch checked={true} onChange={() => alert('Not supported yet')} label="Generate thumbnails" /> */}
      <Callout icon={IconSet.INFO}>
        By default thumbnails are stored in the{' '}
        <ExternalLink url={defaultThumbnailDir}>temporary files directory</ExternalLink>.
      </Callout>
      <div className="filepicker">
        <FileInput
          className="btn-minimal filepicker-input"
          options={{
            properties: ['openDirectory'],
            defaultPath: thumbnailDirectory,
          }}
          onChange={browseThumbnailDirectory}
        >
          Change...
        </FileInput>
        <h3 className="filepicker-label">Thumbnail Directory</h3>
        <div className="filepicker-path">{thumbnailDirectory}</div>
      </div>

      <h3>Thumbnail Diagnostics</h3>
      <p>Live counters for this application session. Cache size is scanned from the selected thumbnail directory.</p>
      <div className="thumbnail-diagnostics">
        <div><strong>{diagnostics.inFlight}</strong><span>In progress</span></div>
        <div><strong>{diagnostics.requested}</strong><span>Requests</span></div>
        <div><strong>{diagnostics.succeeded}</strong><span>Generated</span></div>
        <div><strong>{diagnostics.failed}</strong><span>Failed</span></div>
        <div><strong>{diagnostics.deferred}</strong><span>Deferred</span></div>
        <div><strong>{diagnostics.lastDurationMs} ms</strong><span>Last generation</span></div>
        <div><strong>{Math.round(averageDuration)} ms</strong><span>Average duration</span></div>
        <div><strong>{cacheStats ? cacheStats.files.toLocaleString() : '—'}</strong><span>Cached thumbnails</span></div>
        <div><strong>{cacheStats ? formatBytes(cacheStats.bytes) : '—'}</strong><span>Cache size</span></div>
      </div>
      <ButtonGroup>
        <Button
          onClick={refreshCacheStats}
          styling="outlined"
          icon={IconSet.REFRESH}
          text={isScanningCache ? 'Scanning...' : 'Refresh Cache Stats'}
          disabled={isScanningCache}
        />
        <Button
          onClick={() => { resetThumbnailDiagnostics(); setDiagnostics(getThumbnailDiagnostics()); }}
          styling="outlined"
          icon={IconSet.CLEAR_DATABASE}
          text="Reset Session Counters"
        />
      </ButtonGroup>

      <h3>Development</h3>
      <ButtonGroup>
        <Button
          onClick={() => setIsClearThumbnailCacheOpen(true)}
          styling="outlined"
          icon={IconSet.CLEAR_DATABASE}
          text="Clear Thumbnail Cache"
        />
        <ClearDbButton />
        <Button
          onClick={RendererMessenger.toggleDevTools}
          styling="outlined"
          icon={IconSet.CHROME_DEVTOOLS}
          text="Toggle DevTools"
        />
      </ButtonGroup>
      <Alert
        open={isClearThumbnailCacheOpen}
        icon={IconSet.CLEAR_DATABASE}
        title="Clear generated thumbnail cache?"
        primaryButtonText="Clear Cache"
        onClick={async (button) => {
          if (button === DialogButton.CloseButton) {
            setIsClearThumbnailCacheOpen(false);
          } else {
            await clearThumbnailCache();
          }
        }}
      >
        <p>
          This deletes generated thumbnail files from the thumbnail directory. They will be
          recreated automatically as needed.
        </p>
        <p>Your custom thumbnails are preserved. Original images and the database are not changed.</p>
      </Alert>
    </>
  );
});
