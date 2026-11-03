import { observer } from 'mobx-react-lite';
import SysPath from 'path';
import React, { useCallback, useReducer, useState } from 'react';
import { Button, IconSet, Toggle } from 'widgets';
import { ClientLocation } from '../../entities/Location';
import { removeFromIgnoreList } from '../../stores/ignoreList';
import { useStore } from '../../contexts/StoreContext';

// ---------------------------------------------------------------------------
// Excluded Items settings
//
// Lists every path a user has excluded via the right-click "Exclude from
// Allusion" action (stored in each Location's .allusionignore file) and lets
// them remove an exclusion. Removed entries are re-indexed on the next refresh.
// ---------------------------------------------------------------------------

export const ExcludedItems = observer(() => {
  const { locationStore } = useStore();
  const [formatInput, setFormatInput] = useState('');

  const handleAddExcludedFormat = useCallback(async () => {
    const extension = formatInput.trim().toLowerCase().replace(/^\\.+/, '');
    if (!extension) return;

    const existing = locationStore.managedExtensions.find((item) => item.extension === extension);
    if (!existing) {
      locationStore.addManagedExtension(extension);
      locationStore.toggleManagedExtension(extension);
    } else if (!existing.blocked) {
      locationStore.toggleManagedExtension(extension);
    }

    await locationStore.saveManagedExtensions(true);
    setFormatInput('');
  }, [formatInput, locationStore]);

  // ignoredPaths on a location is a plain array, so force a re-render after edits.
  const [, refresh] = useReducer((x: number) => x + 1, 0);

  const handleRemove = useCallback(
    async (location: ClientLocation, absolutePath: string) => {
      await removeFromIgnoreList(location.path, absolutePath);
      await location.reloadIgnoreList();
      refresh();
    },
    [],
  );

  const locationsWithExclusions = locationStore.locationList.filter(
    (loc) => loc.ignoredPaths.length > 0,
  );

  return (
    <>
      <p className="settings-section-description">
        Items you have excluded with &ldquo;Exclude from Allusion&rdquo;. Removing an entry lets
        Allusion index those files again on the next refresh.
      </p>

      <fieldset className="format-group">
        <legend><strong>Excluded file formats</strong></legend>
        <p className="format-group-description">
          Add extensions to exclude them from indexing. Existing indexed files with that extension are removed from Allusion, but remain on disk. When “Exclude all” is enabled, only formats listed under File Formats are indexed.
        </p>
        <div className="format-add-row">
          <input
            type="text"
            aria-label="File extension to exclude"
            placeholder="e.g. tmp, psd, blend"
            value={formatInput}
            onChange={(e) => setFormatInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddExcludedFormat();
              }
            }}
          />
          <Button
            text="Add"
            icon={IconSet.ADD}
            onClick={handleAddExcludedFormat}
            disabled={formatInput.trim() === ''}
          />
        </div>
        <Toggle
          checked={locationStore.excludeAllExceptIncluded}
          onChange={async (checked) => {
            locationStore.setExcludeAllExceptIncluded(checked);
            await locationStore.saveManagedExtensions(true);
          }}
        >
          Exclude all — only index included file formats
        </Toggle>
        {locationStore.managedExtensions.some((item) => item.blocked) ? (
          <div className="managed-extension-list">
            {locationStore.managedExtensions.filter((item) => item.blocked).map((item) => (
              <div key={item.extension} className="managed-extension-row">
                <span className="format-tag">.{item.extension}</span>
                <Button
                  text="Include"
                  icon={IconSet.ADD}
                  onClick={async () => {
                    locationStore.toggleManagedExtension(item.extension);
                    await locationStore.saveManagedExtensions(false);
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="format-group-description">No excluded file formats.</p>
        )}
      </fieldset>

      {locationsWithExclusions.length === 0 ? (
        <p className="format-group-description">Nothing is excluded.</p>
      ) : (
        locationsWithExclusions.map((location) => (
          <fieldset key={location.id} className="format-group">
            <legend>
              <strong>{location.name}</strong>
            </legend>
            <div className="excluded-item-list">
              {location.ignoredPaths.map((absolutePath) => (
                <div key={absolutePath} className="excluded-item-row">
                  <span
                    className="excluded-item-path"
                    title={absolutePath}
                  >
                    {SysPath.relative(location.path, absolutePath) || absolutePath}
                  </span>
                  <Button
                    text="Remove"
                    icon={IconSet.CLOSE}
                    onClick={() => handleRemove(location, absolutePath)}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        ))
      )}
    </>
  );
});
