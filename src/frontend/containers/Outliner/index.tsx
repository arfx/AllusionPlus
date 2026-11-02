import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useState } from 'react';
import MultiSplit from 'widgets/MultiSplit';
import { useStore } from '../../contexts/StoreContext';
import ExplorerPanel from './ExplorerPanel';
import LocationsPanel from './LocationsPanel';
import SavedSearchesPanel from './SavedSearchesPanel';
import TagsPanel, { OutlinerActionBar } from './TagsPanel';
import FileEditorsPanel from './FileEditorsPanel';

type OutlinerPanelId = 'locations' | 'explorer' | 'tags' | 'saved-searches';
const DEFAULT_PANEL_ORDER: OutlinerPanelId[] = [
  'locations',
  'explorer',
  'tags',
  'saved-searches',
];
const PANEL_ORDER_STORAGE_KEY = 'allusion-outliner-panel-order';

const Outliner = () => {
  const { uiStore } = useStore();
  const [panelOrder, setPanelOrder] = useState<OutlinerPanelId[]>(DEFAULT_PANEL_ORDER);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(PANEL_ORDER_STORAGE_KEY) || 'null');
      if (Array.isArray(stored)) {
        const valid = stored.filter((id): id is OutlinerPanelId =>
          DEFAULT_PANEL_ORDER.includes(id),
        );
        setPanelOrder([
          ...valid,
          ...DEFAULT_PANEL_ORDER.filter((id) => !valid.includes(id)),
        ]);
      }
    } catch (error) {
      console.warn('Could not restore Outliner panel order', error);
    }
  }, []);

  const reorderPanel = useCallback((sourceId: string, targetId: string) => {
    setPanelOrder((current) => {
      if (
        !current.includes(sourceId as OutlinerPanelId) ||
        !current.includes(targetId as OutlinerPanelId)
      ) {
        return current;
      }
      const next = current.filter((id) => id !== sourceId);
      const targetIndex = next.indexOf(targetId as OutlinerPanelId);
      next.splice(targetIndex, 0, sourceId as OutlinerPanelId);
      localStorage.setItem(PANEL_ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const panels: Record<OutlinerPanelId, React.ReactElement> = {
    locations: <LocationsPanel key="locations" />,
    explorer: <ExplorerPanel key="explorer" />,
    tags: <TagsPanel key="tags" />,
    'saved-searches': <SavedSearchesPanel key="saved-searches" />,
  };

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
          onReorderPanel={reorderPanel}
        >
          {panelOrder.map((id) => panels[id])}
          <FileEditorsPanel />
        </MultiSplit>
      </div>
      <OutlinerActionBar />
    </nav>
  );
};

export default observer(Outliner);
