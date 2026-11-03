import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import SysPath from 'path';

import { IconSet } from 'widgets/icons';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { useStore } from '../../../contexts/StoreContext';
import { ExplorerDirectoryEntry, EXPLORER_COMPUTER_ROOT } from '../../../../ipc/messages';
import { RendererMessenger } from '../../../../ipc/renderer';
import { getExplorerBookmarks, saveExplorerBookmarks } from '../../../entities/ExplorerBookmark';
import { generateId } from '../../../../api/id';
import './ExplorerPanel.scss';

const EXPLORER_FOLDER_DRAG_TYPE = 'application/x-allusion-explorer-folder';

type DirectoryState = {
  entries: ExplorerDirectoryEntry[];
  loading: boolean;
  hasSubfolders?: boolean;
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
  onPrime: (entry: ExplorerDirectoryEntry) => void;
};

const FolderNode = ({
  entry,
  level,
  selectedPath,
  expandedPaths,
  directories,
  onSelect,
  onToggle,
  onPrime,
}: FolderNodeProps) => {
  const isExpanded = expandedPaths.has(entry.path);
  const directory = directories[entry.path];
  const children = directory?.entries.filter((item) => item.isDirectory) ?? [];
  const canExpand = directory ? (!!directory.error || directory.loading || directory.hasSubfolders === true || children.length > 0) : true;

  return (
    <div className="explorer-folder-node">
      <div
        className={`explorer-folder-row ${selectedPath === entry.path ? 'selected' : ''}`}
        style={{ paddingLeft: level * 14 }}
        onMouseEnter={() => onPrime(entry)}
        draggable={entry.path !== EXPLORER_COMPUTER_ROOT}
        onDragStart={(event) => {
          if (entry.path === EXPLORER_COMPUTER_ROOT) { event.preventDefault(); return; }
          event.dataTransfer.setData(EXPLORER_FOLDER_DRAG_TYPE, entry.path);
          event.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <span className="explorer-folder-toggle-slot">
          {canExpand ? (
            <button
              type="button"
              className="explorer-folder-toggle"
              aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
              onFocus={() => onPrime(entry)}
              onClick={() => onToggle(entry)}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : null}
        </span>
        <button
          type="button"
          className="explorer-folder-label"
          title={entry.path}
          onClick={() => onSelect(entry.path)}
        >
          <span className="explorer-folder-icon">{IconSet.FOLDER_CLOSE}</span>
          <span>{entry.name}</span>
        </button>
      </div>
      {isExpanded && canExpand && (
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
              onPrime={onPrime}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ExplorerPanel = observer((props: Partial<MultiSplitPaneProps>) => {
  const { uiStore, fileStore } = useStore();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const pendingDirectoryReads = useRef(new Map<string, Promise<ExplorerDirectoryEntry[]>>());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(uiStore.explorerIncludeSubfolders);
  const [directoryRefreshVersion, setDirectoryRefreshVersion] = useState(0);
  const scanId = useRef(0);

  useEffect(() => {
    setIncludeSubfolders(uiStore.explorerIncludeSubfolders);
  }, [uiStore.explorerIncludeSubfolders]);

  const bookmarkCurrentFolder = useCallback(() => {
    const path = uiStore.explorerCurrentDirectory;
    if (!path || path === EXPLORER_COMPUTER_ROOT) return;
    const folderName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    const bookmarks = getExplorerBookmarks();
    if (bookmarks.some((bookmark) =>
      bookmark.path.toLocaleLowerCase() === path.toLocaleLowerCase() &&
      bookmark.includeSubfolders === includeSubfolders
    )) return;
    saveExplorerBookmarks([
      ...bookmarks,
      {
        id: generateId(),
        name: folderName,
        path,
        includeSubfolders,
      },
    ]);
  }, [includeSubfolders, uiStore]);

  const readDirectory = useCallback((absolutePath: string): Promise<ExplorerDirectoryEntry[]> => {
    const pending = pendingDirectoryReads.current.get(absolutePath);
    if (pending) return pending;

    setDirectories((previous) => ({
      ...previous,
      [absolutePath]: { ...previous[absolutePath], entries: previous[absolutePath]?.entries ?? [], loading: true },
    }));

    const request = RendererMessenger.explorerReadDirectory(absolutePath)
      .then((entries) => {
        setDirectories((previous) => ({
          ...previous,
          [absolutePath]: {
            entries,
            loading: false,
            hasSubfolders: entries.some((entry) => entry.isDirectory),
          },
        }));
        return entries;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setDirectories((previous) => ({
          ...previous,
          [absolutePath]: { entries: [], loading: false, hasSubfolders: false, error: message },
        }));
        return [];
      })
      .finally(() => {
        pendingDirectoryReads.current.delete(absolutePath);
      });

    pendingDirectoryReads.current.set(absolutePath, request);
    return request;
  }, []);

  useEffect(() => {
    setExpandedPaths(new Set([EXPLORER_COMPUTER_ROOT]));
    void readDirectory(EXPLORER_COMPUTER_ROOT);
  }, [readDirectory]);

  // When a bookmark or external navigation selects a deep folder, reveal its
  // complete path in the tree instead of leaving the selected item hidden.
  const revealRequest = useRef(0);
  useEffect(() => {
    const targetPath = uiStore.explorerCurrentDirectory;
    if (!targetPath || targetPath === EXPLORER_COMPUTER_ROOT) return;
    const requestId = ++revealRequest.current;
    let cancelled = false;

    const normalizePath = (value: string) => {
      const trimmed = value.replace(/[\\/]+$/, '');
      return trimmed || (value.startsWith('/') ? '/' : value);
    };
    const target = normalizePath(targetPath).toLocaleLowerCase();

    const revealPath = async () => {
      let entries = await readDirectory(EXPLORER_COMPUTER_ROOT);
      let parentPath = EXPLORER_COMPUTER_ROOT;
      const pathsToExpand = [EXPLORER_COMPUTER_ROOT];

      while (!cancelled && revealRequest.current === requestId) {
        const child = entries
          .filter((entry) => entry.isDirectory)
          .find((entry) => {
            const candidate = normalizePath(entry.path).toLocaleLowerCase();
            const separator = /[\\/]$/.test(entry.path) ? '' : SysPath.sep;
            return target === candidate || target.startsWith(candidate + separator);
          });
        if (!child) break;

        pathsToExpand.push(child.path);
        if (normalizePath(child.path).toLocaleLowerCase() === target) break;

        parentPath = child.path;
        entries = await readDirectory(parentPath);
      }

      if (!cancelled && revealRequest.current === requestId) {
        setExpandedPaths((previous) => new Set([...previous, ...pathsToExpand]));
      }
    };

    void revealPath().catch((error) => console.warn('Could not reveal Explorer folder path', targetPath, error));
    return () => {
      cancelled = true;
    };
  }, [readDirectory, uiStore.explorerCurrentDirectory]);

  const primeFolder = useCallback((entry: ExplorerDirectoryEntry) => {
    if (!directories[entry.path] && !pendingDirectoryReads.current.has(entry.path)) {
      void readDirectory(entry.path);
    }
  }, [directories, readDirectory]);

  const chooseDirectory = useCallback(async () => {
    setIsChoosingDirectory(true);
    try {
      const result = await RendererMessenger.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        uiStore.removeSearchCriteriaByKey('absolutePath');
        uiStore.setExplorerCurrentDirectory(result.filePaths[0]);
        setDirectoryRefreshVersion((version) => version + 1);
        void readDirectory(result.filePaths[0]);
      }
    } catch (error) {
      console.error('Could not choose Explorer directory', error);
    } finally {
      setIsChoosingDirectory(false);
    }
  }, [readDirectory, uiStore]);

  const selectDirectory = useCallback(
    (absolutePath: string) => {
      if (absolutePath === EXPLORER_COMPUTER_ROOT) return;
      // Explorer browsing is independent from Library Location search filters.
      // Remove path filters so the gallery shows the selected Explorer folder.
      uiStore.removeSearchCriteriaByKey('absolutePath');
      uiStore.setExplorerCurrentDirectory(absolutePath);
      setDirectoryRefreshVersion((version) => version + 1);
      if (!directories[absolutePath] || directories[absolutePath].error) {
        void readDirectory(absolutePath);
      }
    },
    [directories, readDirectory, uiStore],
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

      const entries = await readDirectory(entry.path);
      const hasSubfolders = entries.some((item) => item.isDirectory);
      setDirectories((previous) => ({
        ...previous,
        [entry.path]: { entries, loading: false, hasSubfolders },
      }));
      if (hasSubfolders) {
        setExpandedPaths((previous) => new Set(previous).add(entry.path));
      }
    },
    [expandedPaths, readDirectory],
  );

  useEffect(() => {
    const selectedDirectory = uiStore.explorerCurrentDirectory;
    if (!selectedDirectory) return;
    const currentScan = ++scanId.current;
    let cancelled = false;

    const scan = async () => {
      const files: string[] = [];
      if (!includeSubfolders) {
        const entries = await RendererMessenger.explorerReadDirectory(selectedDirectory);
        files.push(...entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path));
      } else {
        // Process the queue until it is truly exhausted. The previous worker
        // implementation could let every worker exit while another directory
        // read was still in flight, leaving newly discovered folders unscanned.
        const queue = [selectedDirectory];
        const visited = new Set<string>();
        let queueIndex = 0;

        while (queueIndex < queue.length && !cancelled && scanId.current === currentScan) {
          const directory = queue[queueIndex++];
          if (!directory || visited.has(directory)) continue;
          visited.add(directory);

          try {
            const entries = await RendererMessenger.explorerReadDirectory(directory);
            if (cancelled || scanId.current !== currentScan) return;
            entries.forEach((entry) => {
              if (entry.isDirectory) {
                if (!visited.has(entry.path)) queue.push(entry.path);
              } else {
                files.push(entry.path);
              }
            });
          } catch (error) {
            console.warn('Could not scan Explorer directory', directory, error);
          }
        }
      }
      if (!cancelled && scanId.current === currentScan) {
        await fileStore.setExplorerFiles(files);
      }
    };

    void scan().catch((error) => console.error('Could not load Explorer gallery files', error));
    return () => {
      cancelled = true;
      scanId.current += 1;
    };
  }, [directoryRefreshVersion, fileStore, includeSubfolders, uiStore.explorerCurrentDirectory]);
  const folderTree: ExplorerDirectoryEntry[] = [
    { name: 'Arbeitsplatz', path: EXPLORER_COMPUTER_ROOT, isDirectory: true },
  ];

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
            tooltip="Browse without adding this folder as a Location"
          />
          <ToolbarButton
            icon={IconSet.PLUS}
            text="Bookmark folder"
            onClick={bookmarkCurrentFolder}
            disabled={!uiStore.explorerCurrentDirectory || uiStore.explorerCurrentDirectory === EXPLORER_COMPUTER_ROOT}
            tooltip="Save the current folder in Saved Searches"
          />
        </Toolbar>
      }
      {...props}
    >
      <div className="explorer-browser">
        <aside className="explorer-folder-tree" aria-label="Folder tree">
          <div className="explorer-folder-tree-scroll">
            {folderTree.map((root) => (
              <FolderNode
                key={root.path}
                entry={root}
                level={0}
                selectedPath={uiStore.explorerCurrentDirectory}
                expandedPaths={expandedPaths}
                directories={directories}
                onSelect={selectDirectory}
                onToggle={toggleFolder}
                onPrime={primeFolder}
              />
            ))}
          </div>
          <label className="explorer-recursive-toggle">
            <input
              type="checkbox"
              checked={includeSubfolders}
              onChange={(event) => {
                setIncludeSubfolders(event.target.checked);
                uiStore.setExplorerIncludeSubfolders(event.target.checked);
              }}
            />
            Include subfolders
          </label>
        </aside>
      </div>
    </MultiSplitPane>
  );
});

export default ExplorerPanel;
