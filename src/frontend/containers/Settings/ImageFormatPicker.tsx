import { observer } from 'mobx-react-lite';
import React, { useCallback, useState } from 'react';
import { Button, Checkbox, IconSet, Toggle } from 'widgets';
import { useStore } from '../../contexts/StoreContext';

// ---------------------------------------------------------------------------
// File Formats settings
//
// Allusion uses an "everything-in" model: all file types are indexed by
// default. Users add specific extensions here and toggle whether each one is
// indexed. Unchecking "Indexed" blocks files of that type from being imported.
// ---------------------------------------------------------------------------

export const ImageFormatPicker = observer(() => {
  const { locationStore, fileStore } = useStore();

  const [input, setInput] = useState('');
  const [removeBlockedFiles, setRemoveBlockedFiles] = useState(true);

  const handleAdd = useCallback(() => {
    locationStore.addManagedExtension(input);
    setInput('');
  }, [input, locationStore]);

  const onSubmit = useCallback(async () => {
    // Optionally purge already-indexed files whose extension is now blocked
    if (removeBlockedFiles) {
      for (const ext of locationStore.blockedExtensions) {
        await fileStore.deleteFilesByExtension(ext);
      }
    }

    await locationStore.saveManagedExtensions(removeBlockedFiles);
  }, [fileStore, locationStore, removeBlockedFiles]);

  return (
    <>
      <p className="settings-section-description">
        Allusion indexes every file type by default. Add an extension below and uncheck
        &ldquo;Indexed&rdquo; to stop Allusion from importing files of that type. Changes take
        effect after restarting the app.
      </p>

      <div className="format-add-row">
        <input
          type="text"
          aria-label="File extension to add"
          placeholder="e.g. psd, tmp, blend"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
        />
        <Button text="Add" icon={IconSet.ADD} onClick={handleAdd} disabled={input.trim() === ''} />
      </div>

      {locationStore.managedExtensions.length === 0 ? (
        <p className="format-group-description">
          No managed extensions yet &mdash; every file type is currently indexed.
        </p>
      ) : (
        <div className="managed-extension-list">
          {locationStore.managedExtensions.filter((m) => !m.blocked).map((m) => (
            <div key={m.extension} className="managed-extension-row">
              <span className="format-tag">.{m.extension}</span>
              <Checkbox
                checked={!m.blocked}
                onChange={() => locationStore.toggleManagedExtension(m.extension)}
              >
                Indexed
              </Checkbox>
              <Button
                text="Remove"
                icon={IconSet.CLOSE}
                onClick={() => locationStore.removeManagedExtension(m.extension)}
              />
            </div>
          ))}
        </div>
      )}

      <Toggle checked={removeBlockedFiles} onChange={setRemoveBlockedFiles}>
        Remove already indexed files with newly excluded formats
      </Toggle>

      <div className="settings-actions">
        <Button text="Save" styling="filled" onClick={onSubmit} />
      </div>
    </>
  );
});
