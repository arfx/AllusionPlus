import { observer } from 'mobx-react-lite';
import React from 'react';
import MultiSplit from 'widgets/MultiSplit';
import { useStore } from '../../contexts/StoreContext';
import ExplorerPanel from './ExplorerPanel';
import LocationsPanel from './LocationsPanel';
import SavedSearchesPanel from './SavedSearchesPanel';
import TagsPanel, { OutlinerActionBar } from './TagsPanel';
import FileEditorsPanel from './FileEditorsPanel';

const Outliner = () => {
  const { uiStore } = useStore();

  return (
    <nav id="outliner" aria-expanded={uiStore.isOutlinerOpen}>
      <div
        id="outliner-content"
        className={uiStore.showTreeConnectorLines ? 'show-hierarchy-connector' : ''}
      >
        <MultiSplit
          onUpdateExpansion={uiStore.setOutlinerExpansion}
          expansion={Array.from(uiStore.outlinerExpansion)}
          heights={Array.from(uiStore.outlinerHeights)}
          setHeights={uiStore.setOutlinerHeights}
        >
          <LocationsPanel />
          <ExplorerPanel />
          <TagsPanel />
          <FileEditorsPanel />
          <SavedSearchesPanel />
        </MultiSplit>
      </div>
      <OutlinerActionBar />
    </nav>
  );
};

export default observer(Outliner);
