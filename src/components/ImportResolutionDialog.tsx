/**
 * ImportResolutionDialog — Import 実行直前に解像度を選択させるモーダル。
 *
 * SeedQueue パックは framebuffer 解像度を保持しないため、import 時はユーザが
 * 明示的に解像度を選ぶ必要がある（areas/positions は絶対 px で記述されているが、
 * 「どの解像度を想定したパックか」が分からないと UI 上のプレビュー基準が決まらない）。
 *
 *  - 背景 PNG のサイズが検出できた場合は `suggested` として初期値に提示。
 *  - プリセット / カスタム入力を提供。PackInfoEditor と同じ UI ロジック。
 *  - インポートで既存編集内容が失われ、取り消せない旨を明示。残したい人のために
 *    その場で現在の内容をエクスポートできる（インポートは取り消し履歴を捨てるため）。
 */

import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { MAX_DIMENSION, toSafeInt } from '../core/coords';
import type { Resolution } from '../core/state';
import { presetValueOf, useResolutionPresets } from './resolutionPresets';
import { useDialogWindow, opensDialogWindows } from './dialogs/useDialogWindow';
import { Button, Input, Modal, Select } from './ui';

export interface ImportResolutionDialogProps {
  open: boolean;
  fileName: string;
  /** 背景 PNG から検出した解像度（推定値）。null なら検出失敗。 */
  suggested: Resolution | null;
  /** 既存 state の現在解像度。フォールバックの初期値に使う。 */
  current: Resolution;
  busy?: boolean;
  /** 「現在の内容をエクスポート」の実行中。 */
  exporting?: boolean;
  onExportCurrent: () => void;
  onCancel: () => void;
  onConfirm: (resolution: Resolution) => void;
}

export type ImportResolutionFormProps = Omit<
  ImportResolutionDialogProps,
  'open'
>;

export function ImportResolutionDialog(props: ImportResolutionDialogProps) {
  const { t } = useTranslation();
  const { open, onCancel, onConfirm, onExportCurrent, busy, exporting } = props;
  const locked = busy || exporting;
  useDialogWindow({
    open,
    spec: {
      kind: 'importResolution',
      title: t('importDialog.title'),
      width: 560,
      fileName: props.fileName,
      suggested: props.suggested,
      current: props.current,
    },
    state: { busy, exporting },
    onMessage: (m) => {
      if (m.type === 'result') onConfirm(m.value as Resolution);
      else if (m.type === 'dismiss') {
        if (!locked) onCancel();
      } else if (m.type === 'action' && m.name === 'exportCurrent')
        onExportCurrent();
    },
  });
  if (opensDialogWindows) return null;

  return (
    <Modal
      open={open}
      onClose={locked ? () => undefined : onCancel}
      title={t('importDialog.title')}
      dismissOnBackdrop={!locked}
    >
      <ImportResolutionForm {...props} />
    </Modal>
  );
}

/** 解像度の選択欄とボタン。アプリ内のモーダルと別ウィンドウの両方で使う。 */
export function ImportResolutionForm({
  fileName,
  suggested,
  current,
  busy,
  exporting,
  onExportCurrent,
  onCancel,
  onConfirm,
}: ImportResolutionFormProps) {
  const { t } = useTranslation();
  const presets = useResolutionPresets();

  // 初期値: suggested があれば優先、なければ current。
  // 親側で `key` を切り替えて remount するため、open / suggested の変化に応じた
  // useEffect リセットは不要（コンポーネントの寿命 = 1 回のダイアログセッション）。
  const initial = suggested ?? current;
  const initialPreset = presetValueOf(initial.width, initial.height);

  const [preset, setPreset] = useState<string>(initialPreset);
  const [customW, setCustomW] = useState<string>(String(initial.width));
  const [customH, setCustomH] = useState<string>(String(initial.height));

  const isCustom = preset === 'custom';
  const locked = busy || exporting;

  const handlePresetChange = (value: string) => {
    setPreset(value);
    if (value === 'custom') return;
    const [w, h] = value.split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      setCustomW(String(w));
      setCustomH(String(h));
    }
  };

  // `<input type="number">` は "1e999" を Infinity として返すため、素の
  // `Math.max(1, Math.floor(Number(v) || 0))` では非有限値が state に流れ込む。
  const handleConfirm = () => {
    const w = toSafeInt(customW, initial.width, 1);
    const h = toSafeInt(customH, initial.height, 1);
    setCustomW(String(w));
    setCustomH(String(h));
    onConfirm({ width: w, height: h });
  };

  return (
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          <Trans
            i18nKey="importDialog.fileLine"
            values={{ filename: fileName }}
            components={[
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs" />,
            ]}
          />
        </p>

        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <p>{t('importDialog.warning')}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={onExportCurrent}
            disabled={locked}
          >
            {exporting ? t('header.exporting') : t('importDialog.exportFirst')}
          </Button>
        </div>

        {suggested ? (
          <p className="text-xs text-fg-subtle">
            {t('importDialog.suggestedDetected', {
              width: suggested.width,
              height: suggested.height,
            })}
          </p>
        ) : (
          <p className="text-xs text-fg-subtle">
            {t('importDialog.suggestedMissing')}
          </p>
        )}

        <Select
          label={t('resolution.preset')}
          value={preset}
          onValueChange={handlePresetChange}
          options={presets}
          disabled={locked}
        />

        {isCustom && (
          <div className="grid grid-cols-2 gap-3 rounded-md bg-panel p-3">
            <Input
              label={t('resolution.width')}
              type="number"
              min={1}
              max={MAX_DIMENSION}
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
              disabled={locked}
            />
            <Input
              label={t('resolution.height')}
              type="number"
              min={1}
              max={MAX_DIMENSION}
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
              disabled={locked}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={locked}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={locked}>
            {busy ? t('importDialog.importing') : t('importDialog.confirm')}
          </Button>
        </div>
      </div>
  );
}
