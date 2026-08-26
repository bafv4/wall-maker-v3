/**
 * AreaEditor — main / locked / preparing[i] の数値編集 UI。
 * 親（LayoutEditor）が `area` データと `onChange(patch)` を渡し、ここはローカル入力 → blur で commit。
 *
 * 不変条件:
 *  - 座標は store 側の `mergeAreaPatch`（coords.ts）で必ず Math.floor。ここでは入力検証のみ。
 *  - rows/columns は 1 以上の整数。空欄や 0/負は blur で 1 に丸める。
 *  - width/height は 1 以上。空欄や 0/負は blur で 1 に丸める（x/y は負も許容、空欄は 0）。
 *  - 非有限値（"1e999" → Infinity、"abc" → NaN）は `toSafeInt`（coords.ts）で弾く。
 *
 * 再描画:
 *  - `memo` 済み。親は `area` / `onChange` / `onRemove` を安定参照で渡すこと
 *    （LayoutEditor 側で store の細粒度購読と useCallback/useMemo により担保）。
 *  - props → ローカル state のミラーはフィールド単位で、値が変わったときだけ行う（`syncLocalNumber`）。
 */

import {
  memo,
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_GRID_COUNT, MIN_COORDINATE, toSafeInt } from '../core/coords';
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

/**
 * props の数値をローカル入力文字列へミラーする。
 * 入力途中の表記（`"1."` `"01"` `""` など）でもパース結果が一致していれば文字列を維持し、
 * ユーザの打鍵を巻き戻さない。一致する場合は同じ値を返すので React が再描画をスキップする。
 */
function syncLocalNumber(
  setLocal: Dispatch<SetStateAction<string>>,
  next: number,
): void {
  setLocal((prev) => (Number(prev) === next ? prev : String(next)));
}

function AreaEditorImpl({
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
  // 数値入力（x/y/width/height/rows/columns/padding）は空欄入力を許すためローカル管理
  const [localX, setLocalX] = useState(String(area.x));
  const [localY, setLocalY] = useState(String(area.y));
  const [localWidth, setLocalWidth] = useState(String(area.width));
  const [localHeight, setLocalHeight] = useState(String(area.height));
  const [localRows, setLocalRows] = useState(String(area.rows));
  const [localColumns, setLocalColumns] = useState(String(area.columns));
  const [localPadding, setLocalPadding] = useState(String(area.padding ?? 0));

  // フィールドごとに独立した effect にして、変わっていない入力欄には set を飛ばさない
  // （プレビューのドラッグで x/y だけが動くとき width/height の入力欄は据え置き）。
  useEffect(() => {
    syncLocalNumber(setLocalX, area.x);
  }, [area.x]);

  useEffect(() => {
    syncLocalNumber(setLocalY, area.y);
  }, [area.y]);

  useEffect(() => {
    syncLocalNumber(setLocalWidth, area.width);
  }, [area.width]);

  useEffect(() => {
    syncLocalNumber(setLocalHeight, area.height);
  }, [area.height]);

  useEffect(() => {
    syncLocalNumber(setLocalRows, area.rows);
  }, [area.rows]);

  useEffect(() => {
    syncLocalNumber(setLocalColumns, area.columns);
  }, [area.columns]);

  useEffect(() => {
    syncLocalNumber(setLocalPadding, area.padding ?? 0);
  }, [area.padding]);

  // `<input type="number">` は "1e999" を正当な入力として返すため、素の
  // `Math.max(1, Math.floor(Number(v) || 0))` は Infinity を通してしまう
  // （`Math.max(1, NaN)` も 1 ではなく NaN）。commit は必ず toSafeInt を通す。
  const commitX = useCallback(() => {
    const v = toSafeInt(localX, 0, MIN_COORDINATE);
    onChange({ x: v });
    setLocalX(String(v));
  }, [localX, onChange]);

  const commitY = useCallback(() => {
    const v = toSafeInt(localY, 0, MIN_COORDINATE);
    onChange({ y: v });
    setLocalY(String(v));
  }, [localY, onChange]);

  const commitWidth = useCallback(() => {
    const v = toSafeInt(localWidth, 1, 1);
    onChange({ width: v });
    setLocalWidth(String(v));
  }, [localWidth, onChange]);

  const commitHeight = useCallback(() => {
    const v = toSafeInt(localHeight, 1, 1);
    onChange({ height: v });
    setLocalHeight(String(v));
  }, [localHeight, onChange]);

  const commitRows = useCallback(() => {
    const v = toSafeInt(localRows, 1, 1, MAX_GRID_COUNT);
    onChange({ rows: v });
    setLocalRows(String(v));
  }, [localRows, onChange]);

  const commitColumns = useCallback(() => {
    const v = toSafeInt(localColumns, 1, 1, MAX_GRID_COUNT);
    onChange({ columns: v });
    setLocalColumns(String(v));
  }, [localColumns, onChange]);

  const commitPadding = useCallback(() => {
    const v = toSafeInt(localPadding, 0, 0, 64);
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
            value={localX}
            onChange={(e) => setLocalX(e.target.value)}
            onBlur={commitX}
          />
          <Input
            label={t('areaEditor.y')}
            type="number"
            value={localY}
            onChange={(e) => setLocalY(e.target.value)}
            onBlur={commitY}
          />
          <Input
            label={t('areaEditor.width')}
            type="number"
            min={1}
            value={localWidth}
            onChange={(e) => setLocalWidth(e.target.value)}
            onBlur={commitWidth}
          />
          <Input
            label={t('areaEditor.height')}
            type="number"
            min={1}
            value={localHeight}
            onChange={(e) => setLocalHeight(e.target.value)}
            onBlur={commitHeight}
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

/**
 * ドラッグ中は main/locked/preparing[] のうち動いている 1 つしか `area` が変わらないため、
 * memo 化して残りの AreaEditor（入力欄数十個＋レンジスライダー）の再描画を止める。
 */
export const AreaEditor = memo(AreaEditorImpl);
