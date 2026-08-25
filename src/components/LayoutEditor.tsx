/**
 * LayoutEditor — main / locked / preparing[] のエディタ群と replaceLockedInstances トグル。
 *
 * 再描画:
 *  - ドメイン state 全体（`s.wall`）ではなく、必要なスライスだけを個別に購読する。
 *    背景・音声・lock 画像などの更新でこのツリーを再描画させないため。
 *  - 子の `AreaEditor` は memo 済みなので、渡す `onChange` / `onRemove` は安定参照にする。
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLayoutPresets } from '../core/layoutPresets';
import { useWallStore } from '../store/useWallStore';
import { AreaEditor, type AreaEditorPatch } from './AreaEditor';
import { Button, Select, Switch } from './ui';

export function LayoutEditor() {
  const { t } = useTranslation();
  const main = useWallStore((s) => s.wall.layout.main);
  const locked = useWallStore((s) => s.wall.layout.locked);
  const preparing = useWallStore((s) => s.wall.layout.preparing);
  const resolution = useWallStore((s) => s.wall.resolution);
  const replaceLockedInstances = useWallStore(
    (s) => s.wall.replaceLockedInstances,
  );
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
  const presets = useMemo(() => getLayoutPresets(resolution), [resolution]);
  const presetOptions = useMemo(
    () => presets.map((p) => ({ value: p.id, label: p.name })),
    [presets],
  );
  const [presetId, setPresetId] = useState('');

  const handleApplyPreset = () => {
    const preset = presets.find((p) => p.id === presetId);
    if (preset) applyLayout(preset.layout);
  };

  const handleAddPreparing = useCallback(() => addPreparing(), [addPreparing]);

  // preparing[i] のハンドラは index に閉じるため、件数が変わったときだけ作り直す
  // （毎回新しい無名関数を渡すと memo 済み AreaEditor が全件再描画される）。
  const preparingCount = preparing.length;
  const preparingHandlers = useMemo(
    () =>
      Array.from({ length: preparingCount }, (_, i) => ({
        onChange: (patch: AreaEditorPatch) => updatePreparing(i, patch),
        onRemove: () => removePreparing(i),
      })),
    [preparingCount, updatePreparing, removePreparing],
  );

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
            options={presetOptions}
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
          checked={replaceLockedInstances}
          onChange={setReplaceLockedInstances}
        />
      </div>

      <AreaEditor
        area={main}
        title="main"
        color="#2563eb"
        resolution={resolution}
        onChange={setMain}
        allowGridToggle
      />

      <AreaEditor
        area={locked}
        title="locked"
        color="#ea580c"
        resolution={resolution}
        onChange={setLocked}
        showVisibilityToggle
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg-muted">
            {t('layoutEditor.preparingTitle', { count: preparingCount })}
          </h3>
          <Button variant="outline" size="sm" onClick={handleAddPreparing}>
            {t('layoutEditor.addPreparing')}
          </Button>
        </div>
        {preparingCount === 0 ? (
          <p className="rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
            {t('layoutEditor.preparingEmpty')}
          </p>
        ) : (
          preparing.map((p, i) => (
            <AreaEditor
              key={i}
              area={p}
              title={t('layoutEditor.preparingNumbered', { n: i + 1 })}
              color="#16a34a"
              resolution={resolution}
              onChange={preparingHandlers[i].onChange}
              onRemove={preparingHandlers[i].onRemove}
              showVisibilityToggle
            />
          ))
        )}
      </div>
    </div>
  );
}
