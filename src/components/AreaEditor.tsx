/**
 * AreaEditor — main / locked / preparing[i] の数値編集 UI。
 * 親（LayoutEditor）が `area` データと `onChange(patch)` を渡し、ここはローカル入力 → blur で commit。
 *
 * 不変条件:
 *  - 座標は store 側の `mergeAreaPatch`（coords.ts）で必ず Math.floor。ここでは入力検証のみ。
 *  - rows/columns は 1 以上の整数。空欄や 0/負は blur で 1 に丸める。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MainArea, Resolution, VisibleArea } from '../core/state';
import { Button, Input, Switch } from './ui';

export type AreaEditorTarget = MainArea | VisibleArea;

export type AreaEditorPatch = Partial<MainArea & VisibleArea>;

export interface AreaEditorProps {
  area: AreaEditorTarget;
  title: string;
  color: string;
  resolution: Resolution;
  onChange: (patch: AreaEditorPatch) => void;
  onRemove?: () => void;
  allowGridToggle?: boolean;
  showVisibilityToggle?: boolean;
}

function hasShow(a: AreaEditorTarget): a is VisibleArea {
  return 'show' in a;
}

export function AreaEditor({
  area,
  title,
  color,
  resolution,
  onChange,
  onRemove,
  allowGridToggle = false,
  showVisibilityToggle = false,
}: AreaEditorProps) {
  const { t } = useTranslation();
  // rows/columns/padding は空欄入力を許すためローカル管理
  const [localRows, setLocalRows] = useState(String(area.rows));
  const [localColumns, setLocalColumns] = useState(String(area.columns));
  const [localPadding, setLocalPadding] = useState(String(area.padding ?? 0));

  useEffect(() => {
    setLocalRows(String(area.rows));
    setLocalColumns(String(area.columns));
    setLocalPadding(String(area.padding ?? 0));
  }, [area.rows, area.columns, area.padding]);

  const handleNum = useCallback(
    (field: 'x' | 'y' | 'width' | 'height') =>
      (e: React.ChangeEvent<HTMLInputElement>) =>
        onChange({ [field]: Number(e.target.value) || 0 }),
    [onChange],
  );

  const commitRows = useCallback(() => {
    const v = localRows === '' ? 1 : Math.max(1, Math.floor(Number(localRows)));
    onChange({ rows: v });
    setLocalRows(String(v));
  }, [localRows, onChange]);

  const commitColumns = useCallback(() => {
    const v =
      localColumns === '' ? 1 : Math.max(1, Math.floor(Number(localColumns)));
    onChange({ columns: v });
    setLocalColumns(String(v));
  }, [localColumns, onChange]);

  const commitPadding = useCallback(() => {
    const v =
      localPadding === ''
        ? 0
        : Math.max(0, Math.min(64, Math.floor(Number(localPadding))));
    onChange({ padding: v });
    setLocalPadding(String(v));
  }, [localPadding, onChange]);

  const centerH = useCallback(() => {
    const x = Math.floor((resolution.width - area.width) / 2);
    onChange({ x });
  }, [area.width, resolution.width, onChange]);

  const centerV = useCallback(() => {
    const y = Math.floor((resolution.height - area.height) / 2);
    onChange({ y });
  }, [area.height, resolution.height, onChange]);

  const useGrid = area.useGrid !== false;
  const showGridSection = !allowGridToggle || useGrid;
  const gridWarning =
    showGridSection && area.rows * area.columns > 30
      ? t('areaEditor.tooManyCells')
      : null;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ borderColor: color }}
    >
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color }}>
          {title}
        </h3>
        <div className="flex items-center gap-3">
          {showVisibilityToggle && hasShow(area) && (
            <Switch
              checked={area.show}
              onChange={(b) => onChange({ show: b })}
              label={t('areaEditor.show')}
            />
          )}
          {onRemove && (
            <Button variant="ghost" size="sm" onClick={onRemove}>
              {t('areaEditor.remove')}
            </Button>
          )}
        </div>
      </header>

      <div className="rounded-md bg-panel p-3 mb-3">
        <p className="mb-2 text-xs font-medium text-fg-muted">
          {t('areaEditor.positionSize')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label={t('areaEditor.x')}
            type="number"
            value={area.x}
            onChange={handleNum('x')}
          />
          <Input
            label={t('areaEditor.y')}
            type="number"
            value={area.y}
            onChange={handleNum('y')}
          />
          <Input
            label={t('areaEditor.width')}
            type="number"
            min={1}
            value={area.width}
            onChange={handleNum('width')}
          />
          <Input
            label={t('areaEditor.height')}
            type="number"
            min={1}
            value={area.height}
            onChange={handleNum('height')}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={centerH}>
            {t('areaEditor.centerH')}
          </Button>
          <Button variant="outline" size="sm" onClick={centerV}>
            {t('areaEditor.centerV')}
          </Button>
        </div>
      </div>

      <div className="rounded-md bg-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-fg-muted">
            {t('areaEditor.grid')}
          </p>
          {allowGridToggle && (
            <Switch
              checked={useGrid}
              onChange={(b) => onChange({ useGrid: b })}
              label={t('areaEditor.useGrid')}
            />
          )}
        </div>
        {gridWarning && (
          <p className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700">
            {gridWarning}
          </p>
        )}
        {showGridSection && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Input
                  label={t('areaEditor.rows')}
                  type="number"
                  min={1}
                  value={localRows}
                  onChange={(e) => setLocalRows(e.target.value)}
                  onBlur={commitRows}
                />
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={area.rows}
                  onChange={(e) => onChange({ rows: Number(e.target.value) })}
                  className="mt-2 w-full accent-blue-600"
                />
              </div>
              <div>
                <Input
                  label={t('areaEditor.columns')}
                  type="number"
                  min={1}
                  value={localColumns}
                  onChange={(e) => setLocalColumns(e.target.value)}
                  onBlur={commitColumns}
                />
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={area.columns}
                  onChange={(e) =>
                    onChange({ columns: Number(e.target.value) })
                  }
                  className="mt-2 w-full accent-blue-600"
                />
              </div>
            </div>
            <div>
              <Input
                label={t('areaEditor.padding')}
                type="number"
                min={0}
                max={64}
                value={localPadding}
                onChange={(e) => setLocalPadding(e.target.value)}
                onBlur={commitPadding}
              />
              <input
                type="range"
                min={0}
                max={64}
                value={area.padding ?? 0}
                onChange={(e) =>
                  onChange({ padding: Number(e.target.value) })
                }
                className="mt-2 w-full accent-blue-600"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
