import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useState } from 'react';

import { IconSet } from 'widgets/icons';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
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
  const { uiStore } = useStore();
  const [rootDirectory, setRootDirectory] = useState<string>();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDirectories((previous) => ({
        ...previous,
        [absolutePath]: { entries: [], loading: false, error: message },
      }));
    }
  }, []);

  const selectRoot = useCallback(
    async (absolutePath: string) => {
      setRootDirectory(absolutePath);
      uiStore.setExplorerRootDirectory(absolutePath);
      uiStore.setExplorerCurrentDirectory(absolutePath);
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
        if (isActive) void selectRoot(directory);
      })
      .catch((error) => console.error('Could not resolve Explorer home directory', error));
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
      uiStore.setExplorerCurrentDirectory(absolutePath);
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
      setExpandedPaths((previous) => new Set(previous).add(entry.path));
      if (!directories[entry.path] || directories[entry.path].error) {
        await readDirectory(entry.path);
      }
    },
    [directories, expandedPaths, readDirectory],
  );

  const folderTree = rootDirectory
    ? [{
        name: rootDirectory.split(/[\\/]/).filter(Boolean).pop() || rootDirectory,
        path: rootDirectory,
        isDirectory: true,
      }]
    : [];

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
              selectedPath={uiStore.explorerCurrentDirectory}
              expandedPaths={expandedPaths}
              directories={directories}
              onSelect={selectDirectory}
              onToggle={toggleFolder}
            />
          ))}
        </aside>
      </div>
    </MultiSplitPane>
  );
});

export default ExplorerPanel;
