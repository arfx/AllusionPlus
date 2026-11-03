import { shell } from 'electron';
import { action, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import SysPath from 'path';
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { IconSet, Tree } from 'widgets';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { Menu, MenuCheckboxItem, MenuDivider, MenuItem, useContextMenu } from 'widgets/menus';
import { Callout } from 'widgets/notifications';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import { ITreeItem, createBranchOnKeyDown } from 'widgets/tree';
import { RendererMessenger } from '../../../../ipc/renderer';
import { LocationRemoval, SubLocationExclusion } from '../../../components/RemovalAlert';
import { AppToaster } from '../../../components/Toaster';
import DropContext from '../../../contexts/DropContext';
import { useStore } from '../../../contexts/StoreContext';
import { DnDLocationType, useLocationDnD } from '../../../contexts/TagDnDContext';
import { ClientLocation, ClientSubLocation } from '../../../entities/Location';
import {
  ClientFileSearchCriteria,
  ClientStringSearchCriteria,
  ClientTagSearchCriteria,
} from '../../../entities/SearchCriteria';
import { useAutorun } from '../../../hooks/mobx';
import LocationStore from '../../../stores/LocationStore';
import { IExpansionState } from '../../types';
import { createDragReorderHelper } from '../TreeItemDnD';
import TreeItemRevealer from '../TreeItemRevealer';
import { triggerContextMenuEvent } from '../utils';
import LocationCreationDialog from './LocationCreationDialog';
import LocationRecoveryDialog from './LocationRecoveryDialog';
import { onDragOver as onDragOverFileDnD } from './dnd';
import { useFileDropHandling } from './useFileDnD';
import { StringOperatorType } from 'src/api/data-storage-search';
import UiStore from 'src/frontend/stores/UiStore';
import { LocationPropertiesEditor } from './LocationPropertiesEditor';

export class LocationTreeItemRevealer extends TreeItemRevealer {
  private locationStore?: LocationStore;

  public static readonly instance: LocationTreeItemRevealer = new LocationTreeItemRevealer();
  private constructor() {
    super();
  }

  initialize(
    setExpansion: React.Dispatch<React.SetStateAction<IExpansionState>>,
    locationStore: LocationStore,
  ) {
    super.initializeExpansion(setExpansion);
    this.locationStore = locationStore;
    this.revealSubLocation = action(this.revealSubLocation.bind(this));
  }

  revealSubLocation(locationId: string, absolutePath: string) {
    // For every sublocation on its path to the relativePath, expand it, and then scrollTo + focus the item
    const location = this.locationStore?.locationList.find((l) => l.id === locationId);
    if (!location) {
      return;
    }

    const getSubLocationsToFile = (
      loc: ClientSubLocation | ClientLocation,
    ): ClientSubLocation[] => {
      const match = loc.subLocations.find((child) =>
        absolutePath.startsWith(`${child.path}${SysPath.sep}`),
      );
      if (loc instanceof ClientLocation) {
        return match ? getSubLocationsToFile(match) : [];
      }
      return match ? [loc, ...getSubLocationsToFile(match)] : [loc];
    };

    const subLocationsToExpand = getSubLocationsToFile(location);

    // Location's dataId is its ID, subLocation's dataId's are their paths
    this.revealTreeItem([location.id, ...subLocationsToExpand.map((l) => l.path)]);
  }
}

// Tooltip info
const enum Tooltip {
  Location = 'Add new Location',
  Refresh = 'Refresh locations and detect file changes',
}

interface ITreeData {
  expansion: IExpansionState;
  setExpansion: React.Dispatch<IExpansionState>;
  delete: (location: ClientLocation) => void;
  exclude: (subLocation: ClientSubLocation) => void;
  onEdit: (loc: ClientLocation | ClientSubLocation) => void;
}

const toggleExpansion = (nodeData: ClientLocation | ClientSubLocation, treeData: ITreeData) => {
  const { expansion, setExpansion } = treeData;
  const id = nodeData instanceof ClientLocation ? nodeData.id : nodeData.path;
  setExpansion({ ...expansion, [id]: !expansion[id] });
};

const isExpanded = (nodeData: ClientLocation | ClientSubLocation, treeData: ITreeData) =>
  !!treeData.expansion[nodeData instanceof ClientLocation ? nodeData.id : nodeData.path];

/** Add an additional / or \ in order to enforce files only in the specific directory are found, not in those starting with same name */
const EXPLORER_FOLDER_DRAG_TYPE = 'application/x-allusion-explorer-folder';

const pathAsSearchPath = (path: string) => `${path}${SysPath.sep}`;

const pathCriteria = (path: string, operator: StringOperatorType = 'startsWith') =>
  new ClientStringSearchCriteria(undefined, 'absolutePath', pathAsSearchPath(path), operator);

const getHandleClickCallback = (
  uiStore: UiStore,
  nodeData: ClientLocation | ClientSubLocation,
  existingSearchCrit: ClientFileSearchCriteria | undefined,
) => {
  const handleClickExclude = (event: React.MouseEvent<HTMLElement, MouseEvent>) => {
    const isAppendMode = event.ctrlKey || event.metaKey;
    const shouldExcludeSublocations = event.altKey;
    // Toggle criterias if already present
    if (existingSearchCrit) {
      uiStore.removeSearchCriteria(existingSearchCrit as ClientTagSearchCriteria);
      // if alt include sublocations in the operation
      if (shouldExcludeSublocations) {
        nodeData.subLocations.forEach((sub) => {
          const subPath = pathAsSearchPath(sub.path);
          const subCriteria = uiStore.searchCriteriaList.find(
            (c) =>
              c instanceof ClientStringSearchCriteria &&
              c.value === subPath &&
              c.operator === 'notStartsWith',
          );
          if (subCriteria) {
            uiStore.removeSearchCriteria(subCriteria as ClientTagSearchCriteria);
          }
        });
      }
      return;
    }

    // append/replace
    const mainCriteria = pathCriteria(nodeData.path);
    const extraCriterias: ClientStringSearchCriteria[] = [];
    if (shouldExcludeSublocations) {
      nodeData.subLocations.forEach((sub: any) => {
        const excludeCriteria = pathCriteria(sub.path, 'notStartsWith');
        extraCriterias.push(excludeCriteria);
      });
    }
    if (isAppendMode) {
      uiStore.addSearchCriteria(mainCriteria);
      extraCriterias.forEach((crit) => uiStore.addSearchCriteria(crit));
    } else {
      uiStore.replaceSearchCriteria(mainCriteria);
      extraCriterias.forEach((crit) => uiStore.addSearchCriteria(crit));
    }
  };
  return handleClickExclude;
};

const customKeys = (
  search: (path: string) => void,
  event: React.KeyboardEvent<HTMLLIElement>,
  nodeData: ClientLocation | ClientSubLocation,
  treeData: ITreeData,
) => {
  switch (event.key) {
    case 'F10':
      if (event.shiftKey) {
        triggerContextMenuEvent(event);
      }
      break;

    case 'Enter':
      event.stopPropagation();
      search(nodeData instanceof ClientLocation ? nodeData.path : nodeData.path);
      break;

    case 'Delete':
      if (nodeData instanceof ClientLocation) {
        event.stopPropagation();
        treeData.delete(nodeData);
      }
      break;

    case 'ContextMenu':
      triggerContextMenuEvent(event);
      break;

    default:
      break;
  }
};

const DirectoryMenu = observer(
  ({
    location,
    onExclude,
    onEdit,
  }: {
    location: ClientLocation | ClientSubLocation;
    onExclude: (subLocation: ClientSubLocation) => void;
    onEdit: (loc: ClientLocation | ClientSubLocation) => void;
  }) => {
    const { uiStore } = useStore();

    const path = location instanceof ClientLocation ? location.path : location.path;

    const handleOpenFileExplorer = useCallback(() => shell.showItemInFolder(path), [path]);

    const handleAddToSearch = useCallback(
      () => uiStore.addSearchCriteria(pathCriteria(path)),
      [path, uiStore],
    );

    const handleReplaceSearch = useCallback(
      () => uiStore.replaceSearchCriteria(pathCriteria(path)),
      [path, uiStore],
    );

    const handleAddWithExclusions = useCallback(() => {
      uiStore.addSearchCriteria(pathCriteria(path));
      location.subLocations.forEach((sub) => {
        uiStore.addSearchCriteria(pathCriteria(sub.path, 'notStartsWith'));
      });
    }, [path, location.subLocations, uiStore]);

    const handleReplaceWithExclusions = useCallback(() => {
      uiStore.replaceSearchCriteria(pathCriteria(path));
      location.subLocations.forEach((sub) => {
        uiStore.addSearchCriteria(pathCriteria(sub.path, 'notStartsWith'));
      });
    }, [path, location.subLocations, uiStore]);

    const hasSublocations = location.subLocations.length > 0;

    return (
      <>
        <MenuItem
          onClick={() => onEdit(location)} //
          text="Edit Tags"
          icon={IconSet.TAG_GROUP}
        />
        <MenuItem
          onClick={handleAddToSearch} //
          text="Add to Search Query"
          icon={IconSet.SEARCH}
        />
        <MenuItem
          onClick={handleAddWithExclusions}
          text="Add to Search & Exclude Sublocations"
          icon={IconSet.SEARCH}
          disabled={!hasSublocations}
        />
        <MenuItem
          onClick={handleReplaceSearch}
          text="Replace Search Query"
          icon={IconSet.REPLACE}
        />
        <MenuItem
          onClick={handleReplaceWithExclusions}
          text="Replace Search & Exclude Sublocations"
          icon={IconSet.REPLACE}
          disabled={!hasSublocations}
        />
        <MenuDivider />
        {location instanceof ClientSubLocation && (
          <MenuItem
            // Only show alert when excluding, not when re-including
            onClick={location.isExcluded ? location.toggleExcluded : () => onExclude(location)}
            text={location.isExcluded ? 'Re-include' : 'Exclude'}
            icon={!location.isExcluded ? IconSet.HIDDEN : IconSet.PREVIEW}
          />
        )}
        <MenuItem
          onClick={handleOpenFileExplorer}
          text="Open in File Browser"
          icon={IconSet.FOLDER_CLOSE}
        />
      </>
    );
  },
);

interface IContextMenuProps {
  location: ClientLocation;
  onDelete: (location: ClientLocation) => void;
  onExclude: (location: ClientSubLocation) => void;
  onEdit: (loc: ClientLocation | ClientSubLocation) => void;
}

const LocationTreeContextMenu = observer(
  ({ location, onDelete, onExclude, onEdit }: IContextMenuProps) => {
    const { uiStore } = useStore();

    const openDeleteDialog = useCallback(() => onDelete(location), [location, onDelete]);

    if (location.isBroken) {
      return (
        <Menu>
          <MenuItem
            text="Open Recovery Panel"
            onClick={() => uiStore.openLocationRecovery(location.id)}
            icon={IconSet.WARNING_BROKEN_LINK}
          />
          <MenuItem text="Delete" onClick={openDeleteDialog} icon={IconSet.DELETE} />
        </Menu>
      );
    }

    return (
      <Menu>
        <DirectoryMenu location={location} onExclude={onExclude} onEdit={onEdit} />
        <MenuDivider />
        <MenuCheckboxItem
          checked={location.isWatchingFiles && location.worker !== undefined}
          text="Automatically Sync File Changes"
          onClick={location.toggleWatchFiles}
        />
        <MenuItem text="Delete" onClick={openDeleteDialog} icon={IconSet.DELETE} />
      </Menu>
    );
  },
);

const SubLocation = observer((props: { nodeData: ClientSubLocation; treeData: ITreeData }) => {
  const { nodeData, treeData } = props;
  const { uiStore } = useStore();
  const { expansion, setExpansion } = treeData;
  const show = useContextMenu();
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) =>
      show(
        e.clientX,
        e.clientY,
        <Menu>
          <DirectoryMenu
            location={nodeData}
            onExclude={treeData.exclude}
            onEdit={treeData.onEdit}
          />
        </Menu>,
      ),
    [nodeData, show, treeData.exclude, treeData.onEdit],
  );

  const existingSearchCrit = uiStore.searchCriteriaList.find(
    (c: any) => c.value === pathAsSearchPath(nodeData.path),
  );
  // const isSearched = Boolean(existingSearchCrit);

  const handleClick = useMemo(
    () => getHandleClickCallback(uiStore, nodeData, existingSearchCrit),
    [existingSearchCrit, nodeData, uiStore],
  );

  const { handleDragEnter, handleDragLeave, handleDrop } = useFileDropHandling(
    nodeData.path,
    nodeData.path,
    expansion,
    setExpansion,
  );

  return (
    <div
      className="tree-content-label"
      aria-disabled={nodeData.isExcluded}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={onDragOverFileDnD}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {!nodeData.isExcluded
        ? expansion[nodeData.path]
          ? IconSet.FOLDER_OPEN
          : IconSet.FOLDER_CLOSE
        : IconSet.HIDDEN}
      <div className="label-text">{nodeData.name}</div>
      {/* Indicates whether this item is being searched */}
      {/* TODO: disabled for now; Feels very unnatural in combination with the indicator+button of the Tag */}
      {/* <span className="indicator" aria-hidden={!isSearched}>
        {isSearched ? IconSet.SEARCH : null}
      </span> */}
    </div>
  );
});

const DnDHelper = createDragReorderHelper('locations-dnd-preview', DnDLocationType);

const Location = observer(
  ({ nodeData, treeData }: { nodeData: ClientLocation; treeData: ITreeData }) => {
    const { uiStore, locationStore } = useStore();
    const { expansion, delete: onDelete, onEdit } = treeData;
    const show = useContextMenu();
    const handleContextMenu = useCallback(
      (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        show(
          event.clientX,
          event.clientY,
          <LocationTreeContextMenu
            location={nodeData}
            onDelete={onDelete}
            onExclude={treeData.exclude}
            onEdit={onEdit}
          />,
        );
      },
      [show, nodeData, onDelete, treeData.exclude, onEdit],
    );

    // TODO: idem
    const existingSearchCrit = uiStore.searchCriteriaList.find(
      (c: any) => c.value === pathAsSearchPath(nodeData.path),
    );

    const handleClick = useMemo(
      () => getHandleClickCallback(uiStore, nodeData, existingSearchCrit),
      [existingSearchCrit, nodeData, uiStore],
    );

    const fileDnD = useFileDropHandling(
      nodeData.id,
      nodeData.path,
      expansion,
      treeData.setExpansion,
    );

    const dndData = useLocationDnD();
    const handleDragStart = useCallback(
      (event: React.DragEvent<HTMLDivElement>) =>
        runInAction(() =>
          DnDHelper.onDragStart(event, nodeData.name, uiStore.theme, dndData, nodeData),
        ),
      [dndData, nodeData, uiStore],
    );

    const handleDragOver = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        const ignored = DnDHelper.onDragOver(event, dndData, false);
        if (ignored) {
          onDragOverFileDnD(event);
        }
      },
      [dndData],
    );

    const handleDragLeave = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        runInAction(() => {
          const ignored = DnDHelper.onDragLeave(event);
          if (ignored) {
            fileDnD.handleDragLeave(event);
          }
        });
      },
      [fileDnD],
    );

    const handleDrop = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        runInAction(() => {
          if (!dndData.source || !event.dataTransfer.types.includes(DnDLocationType)) {
            fileDnD.handleDrop(event);
            return;
          }
          const relativeMovePos = DnDHelper.onDrop(event);

          if (relativeMovePos === 'middle') {
            // not possible for locations, no middle position allowed
          } else {
            let target = nodeData;
            if (relativeMovePos === -1) {
              const index = locationStore.locationList.indexOf(target) - 1;
              if (index >= 0) {
                target = locationStore.locationList[index];
              }
            }
            locationStore.reorder(dndData.source, target);
          }
        });
      },
      [dndData.source, fileDnD, nodeData, locationStore],
    );

    return (
      <div
        className="tree-content-label"
        data-watching={nodeData.isWatchingFiles}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragEnter={fileDnD.handleDragEnter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {nodeData.isInitialized && !nodeData.isSettingWatcher && !nodeData.isRefreshing
          ? expansion[nodeData.id]
            ? IconSet.FOLDER_OPEN
            : IconSet.FOLDER_CLOSE
          : IconSet.LOADING}
        <div className="label-text">{nodeData.name}</div>
        {nodeData.isBroken ? (
          <span onClick={() => uiStore.openLocationRecovery(nodeData.id)}>{IconSet.WARNING}</span>
        ) : // Indicates whether this item is being searched
        // TODO: disabled for now; Feels very unnatural in combination with the indicator+button of the Tag
        // <span className="indicator" aria-hidden={!isSearched}>
        //   {isSearched ? IconSet.SEARCH : null}
        // </span>
        null}
      </div>
    );
  },
);

const SubLocationLabel = ({ nodeData, treeData }: { nodeData: any; treeData: any }) => (
  <SubLocation nodeData={nodeData} treeData={treeData} />
);

const mapDirectory = (dir: ClientSubLocation): ITreeItem => ({
  id: dir.path,
  label: SubLocationLabel,
  nodeData: dir,
  children: dir.subLocations.map(mapDirectory),
  isExpanded,
});

const LocationLabel = ({ nodeData, treeData }: { nodeData: any; treeData: any }) => (
  <Location nodeData={nodeData} treeData={treeData} />
);

interface ILocationTreeProps {
  onDelete: (loc: ClientLocation) => void;
  onExclude: (loc: ClientSubLocation) => void;
  onEdit: (loc: ClientLocation | ClientSubLocation) => void;
}

const LocationsTree = ({ onDelete, onExclude, onEdit }: ILocationTreeProps) => {
  const { locationStore, uiStore } = useStore();
  const [expansion, setExpansion] = useState<IExpansionState>({});
  const treeData: ITreeData = useMemo<ITreeData>(
    () => ({
      expansion,
      setExpansion,
      delete: onDelete,
      exclude: onExclude,
      onEdit: onEdit,
    }),
    [expansion, onDelete, onEdit, onExclude],
  );
  const [branches, setBranches] = useState<ITreeItem[]>([]);

  const handleBranchKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLLIElement>,
      nodeData: ClientLocation | ClientSubLocation,
      treeData: ITreeData,
    ) =>
      createBranchOnKeyDown(
        event,
        nodeData,
        treeData,
        isExpanded,
        () => {},
        toggleExpansion,
        customKeys.bind(null, (path: string) => uiStore.replaceSearchCriteria(pathCriteria(path))),
      ),
    [uiStore],
  );

  useAutorun(() => {
    setBranches(
      locationStore.locationList.map((location) => ({
        id: location.id,
        label: LocationLabel,
        children: location.subLocations.map(mapDirectory),
        nodeData: location,
        isExpanded,
      })),
    );
  });
  // TODO: re-run when location (sub)-folder updates: add "lastUpdated" field to location, update when location watcher notices changes?

  useEffect(
    () => LocationTreeItemRevealer.instance.initialize(setExpansion, locationStore),
    [locationStore],
  );

  return (
    <Tree
      id="location-list"
      multiSelect
      children={branches}
      treeData={treeData}
      toggleExpansion={toggleExpansion}
      onBranchKeyDown={handleBranchKeyDown}
    />
  );
};

const LocationsPanel = observer((props: Partial<MultiSplitPaneProps>) => {
  const { locationStore } = useStore();

  const [creatableLocation, setCreatableLocation] = useState<ClientLocation>();
  const [deletableLocation, setDeletableLocation] = useState<ClientLocation>();
  const [excludableSubLocation, setExcludableSubLocation] = useState<ClientSubLocation>();
  const [locationToEdit, setLocationToEdit] = useState<ClientLocation | ClientSubLocation>();

  const addLocationPath = useCallback(async (path: string) => {
    const existingDir = locationStore.exists((dir) => path === dir.path);
    if (existingDir) {
      AppToaster.show({ message: 'This folder has already been added as a location.', timeout: 5000 });
      return;
    }
    const addSeparator = (value: string) => value.endsWith(SysPath.sep) ? value : value + SysPath.sep;
    const parentDir = locationStore.exists((dir) => path.startsWith(addSeparator(dir.path)));
    if (parentDir) {
      AppToaster.show({ message: 'You cannot add a location that is a sub-folder of an existing location.', timeout: 5000 });
      return;
    }
    const pathWithSeparator = addSeparator(path);
    const childDir = locationStore.exists((dir) => dir.path.startsWith(pathWithSeparator));
    if (childDir) {
      AppToaster.show({ message: 'You cannot add a location that is a parent-folder of an existing location.', timeout: 5000 });
      return;
    }
    try {
      const location = await locationStore.create(path);
      setCreatableLocation(location);
    } catch (error) {
      console.error('Could not create Library Location from Explorer folder', path, error);
      AppToaster.show({ message: 'Could not add this folder as a location.', timeout: 5000 });
    }
  }, [locationStore]);

  const handleChooseWatchedDir = useCallback(async () => {
    try {
      const { filePaths } = await RendererMessenger.showOpenDialog({ properties: ['openDirectory'] });
      if (filePaths.length > 0) await addLocationPath(filePaths[0]);
    } catch (error) {
      console.error('Could not choose a Library Location', error);
    }
  }, [addLocationPath]);

  const handleExplorerFolderDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(EXPLORER_FOLDER_DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleExplorerFolderDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(EXPLORER_FOLDER_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const path = event.dataTransfer.getData(EXPLORER_FOLDER_DRAG_TYPE);
    if (path) void addLocationPath(path);
  }, [addLocationPath]);

  const isEmpty = locationStore.locationList.length === 0;
  // Detect file dropping and show a blue outline around location panel
  const { isDropping } = useContext(DropContext);

  // FIXME: something is broken with the isDropping detection. there was "isEmpty || isDropping" in here before
  return (
    <MultiSplitPane
      id="locations"
      title="Locations"
      className={`${isEmpty ? 'attention' : ''} ${isDropping ? 'info' : ''}`}
      headerToolbar={
        <Toolbar controls="location-list" isCompact>
          {locationStore.locationList.length > 0 && (
            <ToolbarButton
              icon={IconSet.RELOAD_COMPACT}
              text="Refresh"
              onClick={action(() => locationStore.updateLocations())}
              tooltip={Tooltip.Refresh}
            />
          )}
          <ToolbarButton
            icon={IconSet.PLUS}
            text="New Location"
            onClick={handleChooseWatchedDir}
            tooltip={Tooltip.Location}
          />
        </Toolbar>
      }
      {...props}
      onDragOverCapture={handleExplorerFolderDragOver}
      onDropCapture={handleExplorerFolderDrop}
    >
      <LocationsTree
        onDelete={setDeletableLocation}
        onExclude={setExcludableSubLocation}
        onEdit={setLocationToEdit}
      />
      {isEmpty && <Callout icon={IconSet.INFO}>Click + to choose a location.</Callout>}

      <LocationRecoveryDialog />

      {creatableLocation && (
        <LocationCreationDialog
          location={creatableLocation}
          onClose={() => setCreatableLocation(undefined)}
        />
      )}
      {deletableLocation && (
        <LocationRemoval
          object={deletableLocation}
          onClose={() => setDeletableLocation(undefined)}
        />
      )}
      {excludableSubLocation && (
        <SubLocationExclusion
          object={excludableSubLocation}
          onClose={() => setExcludableSubLocation(undefined)}
        />
      )}
      {locationToEdit && (
        <LocationPropertiesEditor
          locationToEdit={locationToEdit}
          onClose={() => setLocationToEdit(undefined)}
        />
      )}
    </MultiSplitPane>
  );
});

export default LocationsPanel;
