/**
 * ImportResolutionDialog — Import 実行直前に解像度を選択させるモーダル。
 *
 * SeedQueue パックは framebuffer 解像度を保持しないため、import 時はユーザが
 * 明示的に解像度を選ぶ必要がある（areas/positions は絶対 px で記述されているが、
 * 「どの解像度を想定したパックか」が分からないと UI 上のプレビュー基準が決まらない）。
 *
 *  - 背景 PNG のサイズが検出できた場合は `suggested` として初期値に提示。
 *  - プリセット / カスタム入力を提供。PackInfoEditor と同じ UI ロジック。
 *  - インポートで既存編集内容が失われる旨を明示。
 */

import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { Resolution } from '../core/state';
import { presetValueOf, useResolutionPresets } from './resolutionPresets';
import { Button, Input, Modal, Select } from './ui';

export interface ImportResolutionDialogProps {
  open: boolean;
  fileName: string;
  /** 背景 PNG から検出した解像度（推定値）。null なら検出失敗。 */
  suggested: Resolution | null;
  /** 既存 state の現在解像度。フォールバックの初期値に使う。 */
  current: Resolution;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (resolution: Resolution) => void;
}

export function ImportResolutionDialog({
  open,
  fileName,
  suggested,
  current,
  busy,
  onCancel,
  onConfirm,
}: ImportResolutionDialogProps) {
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

  const handlePresetChange = (value: string) => {
    setPreset(value);
    if (value === 'custom') return;
    const [w, h] = value.split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      setCustomW(String(w));
      setCustomH(String(h));
    }
  };

  const handleConfirm = () => {
    const w = Math.max(1, Math.floor(Number(customW) || 0));
    const h = Math.max(1, Math.floor(Number(customH) || 0));
    onConfirm({ width: w, height: h });
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={t('importDialog.title')}
      dismissOnBackdrop={!busy}
    >
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

        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('importDialog.warning')}
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
          disabled={busy}
        />

        {isCustom && (
          <div className="grid grid-cols-2 gap-3 rounded-md bg-panel p-3">
            <Input
              label={t('resolution.width')}
              type="number"
              min={1}
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
              disabled={busy}
            />
            <Input
              label={t('resolution.height')}
              type="number"
              min={1}
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
              disabled={busy}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={busy}>
            {busy ? t('importDialog.importing') : t('importDialog.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
