import React, { useCallback, useState } from 'react';

import { IconSet } from 'widgets/icons';
import { Callout } from 'widgets/notifications';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { RendererMessenger } from '../../../../ipc/renderer';

const ExplorerPanel = (props: Partial<MultiSplitPaneProps>) => {
  const [currentDirectory, setCurrentDirectory] = useState<string>();

  const chooseDirectory = useCallback(async () => {
    const result = await RendererMessenger.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      setCurrentDirectory(result.filePaths[0]);
    }
  }, []);

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
            tooltip="Browse a folder without adding it as a Location"
          />
        </Toolbar>
      }
      {...props}
    >
      {currentDirectory ? (
        <Callout icon={IconSet.INFO}>
          Selected folder: {currentDirectory}. Direct folder browsing is the next implementation
          step; this selection does not create a Location or start indexing.
        </Callout>
      ) : (
        <Callout icon={IconSet.INFO}>
          Choose a folder to browse it directly. Explorer folders are independent from Locations
          and are not added to the library automatically.
        </Callout>
      )}
    </MultiSplitPane>
  );
};

export default ExplorerPanel;
