/**
 * LayoutEditor — main / locked / preparing[] のエディタ群と replaceLockedInstances トグル。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLayoutPresets } from '../core/layoutPresets';
import { useWallStore } from '../store/useWallStore';
import { AreaEditor } from './AreaEditor';
import { Button, Select, Switch } from './ui';

export function LayoutEditor() {
  const { t } = useTranslation();
  const wall = useWallStore((s) => s.wall);
  const setMain = useWallStore((s) => s.setMain);
  const setLocked = useWallStore((s) => s.setLocked);
  const addPreparing = useWallStore((s) => s.addPreparing);
  const removePreparing = useWallStore((s) => s.removePreparing);
  const updatePreparing = useWallStore((s) => s.updatePreparing);
  const applyLayout = useWallStore((s) => s.applyLayout);
  const setReplaceLockedInstances = useWallStore(
    (s) => s.setReplaceLockedInstances,
  );

  // プリセットは現在の解像度に合わせて実 px に展開する（解像度変更で再計算）。
  const presets = useMemo(
    () => getLayoutPresets(wall.resolution),
    [wall.resolution],
  );
  const [presetId, setPresetId] = useState('');

  const handleApplyPreset = () => {
    const preset = presets.find((p) => p.id === presetId);
    if (preset) applyLayout(preset.layout);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg bg-panel p-3">
        <span className="block text-xs font-medium text-fg-muted">
          {t('layoutEditor.presetTitle')}
        </span>
        <div className="flex items-end gap-2">
          <Select
            className="flex-1"
            value={presetId}
            onValueChange={setPresetId}
            placeholder={t('layoutEditor.presetPlaceholder')}
            options={presets.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-10"
            disabled={!presetId}
            onClick={handleApplyPreset}
          >
            {t('layoutEditor.applyPreset')}
          </Button>
        </div>
        <p className="text-[11px] text-fg-subtle">
          {t('layoutEditor.presetHint')}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-panel p-3">
        <span className="text-sm font-medium text-fg">
          {t('layoutEditor.replaceLockedInstances')}
        </span>
        <Switch
          checked={wall.replaceLockedInstances}
          onChange={setReplaceLockedInstances}
        />
      </div>

      <AreaEditor
        area={wall.layout.main}
        title="main"
        color="#2563eb"
        resolution={wall.resolution}
        onChange={setMain}
        allowGridToggle
      />

      <AreaEditor
        area={wall.layout.locked}
        title="locked"
        color="#ea580c"
        resolution={wall.resolution}
        onChange={setLocked}
        showVisibilityToggle
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg-muted">
            {t('layoutEditor.preparingTitle', {
              count: wall.layout.preparing.length,
            })}
          </h3>
          <Button variant="outline" size="sm" onClick={() => addPreparing()}>
            {t('layoutEditor.addPreparing')}
          </Button>
        </div>
        {wall.layout.preparing.length === 0 ? (
          <p className="rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
            {t('layoutEditor.preparingEmpty')}
          </p>
        ) : (
          wall.layout.preparing.map((p, i) => (
            <AreaEditor
              key={i}
              area={p}
              title={t('layoutEditor.preparingNumbered', { n: i + 1 })}
              color="#16a34a"
              resolution={wall.resolution}
              onChange={(patch) => updatePreparing(i, patch)}
              onRemove={() => removePreparing(i)}
              showVisibilityToggle
            />
          ))
        )}
      </div>
    </div>
  );
}
