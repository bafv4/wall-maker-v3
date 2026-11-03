/**
 * LayoutEditor — main / locked / preparing[] のエディタ群と replaceLockedInstances トグル。
 *
 * 再描画:
 *  - ドメイン state 全体（`s.wall`）ではなく、必要なスライスだけを個別に購読する。
 *    背景・音声・lock 画像などの更新でこのツリーを再描画させないため。
 *  - 子の `AreaEditor` は memo 済みなので、渡す `onChange` / `onRemove` は安定参照にする。
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLayoutPresets } from '../core/layoutPresets';
import { notifyUndoable } from '../store/history';
import { useWallStore, type AreaTarget } from '../store/useWallStore';
import { AreaEditor, type AreaEditorPatch } from './AreaEditor';
import { Button, Select, Switch } from './ui';

export function LayoutEditor() {
  const { t } = useTranslation();
  const replaceLockedId = useId();
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
  const selectedAreas = useWallStore((s) => s.ui.selectedAreas);
  const selectAreas = useWallStore((s) => s.selectAreas);

  // プレビューの選択とカードの強調を連動させる。カードを触ったら、そのエリアだけを選ぶ
  // （既に単独で選ばれていれば store を書き換えない）。
  const isSelected = (key: string) =>
    selectedAreas.some(
      (r) => (r.kind === 'preparing' ? `preparing:${r.index}` : r.kind) === key,
    );
  const selectOnly = useCallback(
    (target: AreaTarget) => {
      const cur = useWallStore.getState().ui.selectedAreas;
      const same =
        cur.length === 1 &&
        cur[0].kind === target.kind &&
        (target.kind !== 'preparing' ||
          (cur[0].kind === 'preparing' && cur[0].index === target.index));
      if (!same) selectAreas([target]);
    },
    [selectAreas],
  );
  const selectMain = useCallback(() => selectOnly({ kind: 'main' }), [selectOnly]);
  const selectLocked = useCallback(
    () => selectOnly({ kind: 'locked' }),
    [selectOnly],
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
        onRemove: () => {
          removePreparing(i);
          notifyUndoable(t('history.deleted.preparing', { n: i + 1 }));
        },
        onSelect: () => selectOnly({ kind: 'preparing', index: i }),
      })),
    [preparingCount, updatePreparing, removePreparing, selectOnly, t],
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
            aria-label={t('layoutEditor.presetTitle')}
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
        <p className="text-xs text-fg-subtle">
          {t('layoutEditor.presetHint')}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-panel p-3">
        <label
          htmlFor={replaceLockedId}
          className="cursor-pointer text-sm font-medium text-fg"
        >
          {t('layoutEditor.replaceLockedInstances')}
        </label>
        <Switch
          id={replaceLockedId}
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
        selected={isSelected('main')}
        onSelect={selectMain}
      />

      <AreaEditor
        area={locked}
        title="locked"
        color="#ea580c"
        resolution={resolution}
        onChange={setLocked}
        showVisibilityToggle
        selected={isSelected('locked')}
        onSelect={selectLocked}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">
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
              onSelect={preparingHandlers[i].onSelect}
              selected={isSelected(`preparing:${i}`)}
              showVisibilityToggle
            />
          ))
        )}
      </div>
    </div>
  );
}
