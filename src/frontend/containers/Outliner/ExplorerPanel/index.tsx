import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconSet } from 'widgets/icons';
import { Callout } from 'widgets/notifications';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { encodeFilePath } from '../../../../../common/fs';
import { useStore } from '../../../contexts/StoreContext';
import { ExplorerDirectoryEntry } from '../../../../ipc/messages';
import { RendererMessenger } from '../../../../ipc/renderer';
import './ExplorerPanel.scss';

type DirectoryState = {
  entries: ExplorerDirectoryEntry[];
  loading: boolean;
  error?: string;
};

type FolderNodeProps = {
  entry: ExplorerDirectoryEntry;
  level: number;
  selectedPath: string;
  expandedPaths: Set<string>;
  directories: Record<string, DirectoryState>;
  onSelect: (path: string) => void;
  onToggle: (entry: ExplorerDirectoryEntry) => void;
};

const FolderNode = ({
  entry,
  level,
  selectedPath,
  expandedPaths,
  directories,
  onSelect,
  onToggle,
}: FolderNodeProps) => {
  const isExpanded = expandedPaths.has(entry.path);
  const directory = directories[entry.path];
  const children = directory?.entries.filter((item) => item.isDirectory) ?? [];

  return (
    <div className="explorer-folder-node">
      <div
        className={`explorer-folder-row ${selectedPath === entry.path ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + level * 16 }}
      >
        <button
          type="button"
          className="explorer-folder-toggle"
          aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
          onClick={() => onToggle(entry)}
        >
          {isExpanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="explorer-folder-label"
          title={entry.path}
          onClick={() => onSelect(entry.path)}
        >
          <span className="explorer-folder-icon">📁</span>
          <span>{entry.name}</span>
        </button>
      </div>
      {isExpanded && (
        <div className="explorer-folder-children">
          {directory?.loading && <div className="explorer-tree-message">Loading…</div>}
          {directory?.error && (
            <div className="explorer-tree-message error">Could not read folder. Select to retry.</div>
          )}
          {children.map((child) => (
            <FolderNode
              key={child.path}
              entry={child}
              level={level + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              directories={directories}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
          {!directory?.loading && !directory?.error && directory && children.length === 0 && (
            <div className="explorer-tree-message">No subfolders</div>
          )}
        </div>
      )}
    </div>
  );
};

const ExplorerPanel = observer((props: Partial<MultiSplitPaneProps>) => {
  const { uiStore, imageLoader } = useStore();
  const [rootDirectory, setRootDirectory] = useState<string>();
  const [currentDirectory, setCurrentDirectory] = useState<string>();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(uiStore.explorerIncludeSubfolders);
  const [recursiveFiles, setRecursiveFiles] = useState<ExplorerDirectoryEntry[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [thumbnailPaths, setThumbnailPaths] = useState<Record<string, string>>({});
  const scanId = useRef(0);

  const readDirectory = useCallback(async (absolutePath: string) => {
    setDirectories((previous) => ({
      ...previous,
      [absolutePath]: { entries: previous[absolutePath]?.entries ?? [], loading: true },
    }));
    try {
      const entries = await RendererMessenger.explorerReadDirectory(absolutePath);
      setDirectories((previous) => ({
        ...previous,
        [absolutePath]: { entries, loading: false },
      }));
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDirectories((previous) => ({
        ...previous,
        [absolutePath]: { entries: [], loading: false, error: message },
      }));
      return [];
    }
  }, []);

  const selectRoot = useCallback(
    async (absolutePath: string) => {
      setRootDirectory(absolutePath);
      setCurrentDirectory(absolutePath);
      uiStore.setExplorerRootDirectory(absolutePath);
      setDirectories({});
      setExpandedPaths(new Set([absolutePath]));
      await readDirectory(absolutePath);
    },
    [readDirectory, uiStore],
  );

  useEffect(() => {
    let isActive = true;
    const initialDirectory = uiStore.explorerRootDirectory;
    const resolveInitialDirectory = initialDirectory
      ? Promise.resolve(initialDirectory)
      : RendererMessenger.getPath('home');
    resolveInitialDirectory
      .then((directory) => {
        if (isActive) {
          void selectRoot(directory);
        }
      })
      .catch((error) => {
        console.error('Could not resolve Explorer home directory', error);
      });
    return () => {
      isActive = false;
    };
  }, [selectRoot, uiStore]);

  const chooseDirectory = useCallback(async () => {
    setIsChoosingDirectory(true);
    try {
      const result = await RendererMessenger.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        await selectRoot(result.filePaths[0]);
      }
    } catch (error) {
      console.error('Could not choose Explorer directory', error);
    } finally {
      setIsChoosingDirectory(false);
    }
  }, [selectRoot]);

  const selectDirectory = useCallback(
    (absolutePath: string) => {
      setCurrentDirectory(absolutePath);
      if (!directories[absolutePath] || directories[absolutePath].error) {
        void readDirectory(absolutePath);
      }
    },
    [directories, readDirectory],
  );

  const toggleFolder = useCallback(
    async (entry: ExplorerDirectoryEntry) => {
      if (expandedPaths.has(entry.path)) {
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          next.delete(entry.path);
          return next;
        });
        return;
      }

      setExpandedPaths((previous) => new Set(previous).add(entry.path));
      if (!directories[entry.path] || directories[entry.path].error) {
        await readDirectory(entry.path);
      }
    },
    [directories, expandedPaths, readDirectory],
  );

  const currentEntries = directories[currentDirectory ?? '']?.entries ?? [];

  useEffect(() => {
    const thisScan = ++scanId.current;
    if (!includeSubfolders || !currentDirectory) {
      setRecursiveFiles([]);
      setIsScanning(false);
      setScanError(undefined);
      return;
    }

    let cancelled = false;
    setRecursiveFiles([]);
    setScanError(undefined);
    setIsScanning(true);

    const scan = async () => {
      const pending = [currentDirectory];
      let queueIndex = 0;
      let skippedDirectories = 0;
      const visited = new Set<string>();
      const foundFiles: ExplorerDirectoryEntry[] = [];
      let scannedDirectories = 0;

      while (queueIndex < pending.length && !cancelled && scanId.current === thisScan) {
        const directoryPath = pending[queueIndex++];
        if (visited.has(directoryPath)) {
          continue;
        }
        visited.add(directoryPath);

        try {
          const entries = await RendererMessenger.explorerReadDirectory(directoryPath);
          scannedDirectories += 1;
          entries.forEach((entry) => {
            if (entry.isDirectory) {
              pending.push(entry.path);
            } else {
              foundFiles.push(entry);
            }
          });
          if (scannedDirectories % 8 === 0) {
            setRecursiveFiles([...foundFiles]);
          }
        } catch (error) {
          // A permission-denied or disconnected folder should not stop the rest of the scan.
          skippedDirectories += 1;
          console.warn('Could not scan Explorer directory', directoryPath, error);
        }
      }

      if (!cancelled && scanId.current === thisScan) {
        setRecursiveFiles(foundFiles);
        setScanError(
          skippedDirectories > 0
            ? `Could not read ${skippedDirectories} folder(s); some files may be missing.`
            : undefined,
        );
        setIsScanning(false);
      }
    };

    void scan().catch((error) => {
      if (!cancelled && scanId.current === thisScan) {
        setScanError(error instanceof Error ? error.message : String(error));
        setIsScanning(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, includeSubfolders]);

  const files = useMemo(
    () =>
      (includeSubfolders ? recursiveFiles : currentEntries).filter(
        (entry) => !entry.isDirectory,
      ),
    [currentEntries, includeSubfolders, recursiveFiles],
  );

  const imageExtensions = useMemo(
    () =>
      new Set([
        'gif',
        'png',
        'apng',
        'jpg',
        'jpeg',
        'jfif',
        'webp',
        'avif',
        'bmp',
        'ico',
        'svg',
        'tif',
        'tiff',
        'psd',
        'kra',
        'exr',
        'mp4',
        'webm',
        'ogg',
        'mov',
      ]),
    [],
  );

  const imageFiles = useMemo(
    () =>
      files.filter((file) => {
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        return imageExtensions.has(extension);
      }),
    [files, imageExtensions],
  );

  useEffect(() => {
    let cancelled = false;
    const visiblePaths = new Set(imageFiles.map((file) => file.path));
    setThumbnailPaths((previous) => {
      const next: Record<string, string> = {};
      Object.entries(previous).forEach(([filePath, thumbnailPath]) => {
        if (visiblePaths.has(filePath)) next[filePath] = thumbnailPath;
      });
      return next;
    });

    const generate = async () => {
      // Keep a small number of requests active so large folders do not flood
      // the shared worker queue or delay thumbnails already visible elsewhere.
      for (let index = 0; index < imageFiles.length && !cancelled; index += 4) {
        const batch = imageFiles.slice(index, index + 4);
        await Promise.all(
          batch.map(async (file) => {
            const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
            try {
              const thumbnailPath = await imageLoader.ensureExplorerThumbnail(
                file.path,
                extension,
                uiStore.thumbnailDirectory,
                1,
              );
              if (!cancelled) {
                setThumbnailPaths((previous) => ({ ...previous, [file.path]: thumbnailPath }));
              }
            } catch (error) {
              // A single unsupported or damaged file must not prevent other previews.
              console.warn('Could not generate Explorer thumbnail', file.path, error);
            }
          }),
        );
      }
    };

    void generate();
    return () => {
      cancelled = true;
    };
  }, [imageFiles, imageLoader, uiStore.thumbnailDirectory]);

  const folderTree = useMemo(() => {
    if (!rootDirectory) {
      return [];
    }
    const rootName = rootDirectory.split(/[\\/]/).filter(Boolean).pop() || rootDirectory;
    return [
      {
        name: rootName,
        path: rootDirectory,
        isDirectory: true,
      },
    ];
  }, [rootDirectory]);

  return (
    <MultiSplitPane
      id="explorer"
      title="Explorer"
      headerToolbar={
        <Toolbar controls="explorer-panel" isCompact>
          <ToolbarButton
            icon={IconSet.FOLDER_CLOSE}
            text="Choose folder"
            onClick={chooseDirectory}
            disabled={isChoosingDirectory}
            tooltip="Browse a folder without adding it as a Location"
          />
        </Toolbar>
      }
      {...props}
    >
      <div className="explorer-browser">
        <aside className="explorer-folder-tree" aria-label="Folder tree">
          {folderTree.map((root) => (
            <FolderNode
              key={root.path}
              entry={root}
              level={0}
              selectedPath={currentDirectory ?? ''}
              expandedPaths={expandedPaths}
              directories={directories}
              onSelect={selectDirectory}
              onToggle={toggleFolder}
            />
          ))}
        </aside>
        <section className="explorer-folder-content" aria-label="Folder contents">
          <div className="explorer-current-path" title={currentDirectory}>
            {currentDirectory || 'Loading home directory…'}
          </div>
          <label className="explorer-recursive-toggle">
            <input
              type="checkbox"
              checked={includeSubfolders}
              onChange={(event) => {
                const checked = event.target.checked;
                setIncludeSubfolders(checked);
                uiStore.setExplorerIncludeSubfolders(checked);
              }}
            />
            Include subfolders
          </label>
          {directories[currentDirectory ?? '']?.loading && (
            <Callout icon={IconSet.INFO}>Reading folder…</Callout>
          )}
          {directories[currentDirectory ?? '']?.error && (
            <Callout icon={IconSet.INFO}>
              Could not read this folder: {directories[currentDirectory ?? ''].error}
            </Callout>
          )}
          {isScanning && (
            <div className="explorer-scan-status">Scanning subfolders… ({files.length} files found)</div>
          )}
          {scanError && <Callout icon={IconSet.INFO}>Could not complete the scan: {scanError}</Callout>}
          {!isScanning && !directories[currentDirectory ?? '']?.loading && files.length === 0 && (
            <Callout icon={IconSet.INFO}>This folder does not contain any files.</Callout>
          )}
          <div className="explorer-image-grid">
            {imageFiles.map((file) => (
              <div className="explorer-image-item" key={file.path} title={file.path}>
                {thumbnailPaths[file.path] ? (
                  <img src={encodeFilePath(thumbnailPaths[file.path])} alt={file.name} loading="lazy" />
                ) : (
                  <div className="explorer-thumbnail-loading">Generating preview…</div>
                )}
                <span>{file.name}</span>
              </div>
            ))}
          </div>
          <ul className="explorer-file-list">
            {files
              .filter((file) => !imageFiles.includes(file))
              .map((file) => (
                <li key={file.path} title={file.path}>
                  <span className="explorer-file-icon">▧</span>
                  {file.name}
                </li>
              ))}
          </ul>
        </section>
      </div>
    </MultiSplitPane>
  );
});

export default ExplorerPanel;
