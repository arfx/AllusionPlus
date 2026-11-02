import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { IconSet } from 'widgets/icons';
import { Callout } from 'widgets/notifications';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
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
          {directory?.error && <div className="explorer-tree-message error">{directory.error}</div>}
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

const ExplorerPanel = (props: Partial<MultiSplitPaneProps>) => {
  const [rootDirectory, setRootDirectory] = useState<string>();
  const [currentDirectory, setCurrentDirectory] = useState<string>();
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
      setDirectories({});
      setExpandedPaths(new Set([absolutePath]));
      await readDirectory(absolutePath);
    },
    [readDirectory],
  );

  useEffect(() => {
    let isActive = true;
    RendererMessenger.getPath('home')
      .then((home) => {
        if (isActive) {
          void selectRoot(home);
        }
      })
      .catch((error) => {
        console.error('Could not resolve Explorer home directory', error);
      });
    return () => {
      isActive = false;
    };
  }, [selectRoot]);

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
      if (!directories[entry.path]) {
        await readDirectory(entry.path);
      }
    },
    [directories, expandedPaths, readDirectory],
  );

  const currentEntries = directories[currentDirectory ?? '']?.entries ?? [];
  const files = useMemo(
    () => currentEntries.filter((entry) => !entry.isDirectory),
    [currentEntries],
  );

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
              onSelect={setCurrentDirectory}
              onToggle={toggleFolder}
            />
          ))}
        </aside>
        <section className="explorer-folder-content" aria-label="Folder contents">
          <div className="explorer-current-path" title={currentDirectory}>
            {currentDirectory || 'Loading home directory…'}
          </div>
          {directories[currentDirectory ?? '']?.loading && (
            <Callout icon={IconSet.INFO}>Reading folder…</Callout>
          )}
          {directories[currentDirectory ?? '']?.error && (
            <Callout icon={IconSet.INFO}>
              Could not read this folder: {directories[currentDirectory ?? ''].error}
            </Callout>
          )}
          {!directories[currentDirectory ?? '']?.loading &&
            !directories[currentDirectory ?? '']?.error &&
            files.length === 0 && (
              <Callout icon={IconSet.INFO}>This folder does not contain any files.</Callout>
            )}
          <ul className="explorer-file-list">
            {files.map((file) => (
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
};

export default ExplorerPanel;
