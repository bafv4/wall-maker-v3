/**
 * BackgroundEditor — background.layers の追加・編集・並び替え・削除。
 *
 * 仕様: REWRITE_SPEC.md 第4.2章（Canvas 合成）/ 第7.1章（判別共用体）。
 *  - 配列の先頭が「奥」、末尾が「手前」（buildPack/renderBackground の描画順と一致）。
 *    一覧は一般的な画像編集ツールと同じく**上ほど手前**に並べる（表示だけ反転する）。
 *  - 並び替えは一覧のつまみのドラッグ（dnd-kit）。キーボードはつまみで Space → ↑↓ → Space。
 *  - 全ての state mutation は `updateBackgroundLayer(id, patch)` で型安全に。
 *  - color/image/gradient/shape の判別は patch.type で narrow される。
 *
 * UI: アコーディオンを廃止し、上部レイヤ一覧 + 下部エディタの master-detail 構造に変更。
 *  - 選択中レイヤは store の `ui.selectedBackgroundLayerId` を共有
 *    （image+manual のときプレビュー操作モードも兼ねる）。
 *  - image レイヤのヘッダにはファイル名を表示。
 *
 * 画像の取り込み: **デコードできることを取り込み境界で検証する**（`assertDecodable`）。
 *  - renderBackground / buildPack はどちらも `createImageBitmap` でレイヤを描画する。
 *    そこで落ちるバイト列（SVG・破損 PNG 等）を state に入れると、プレビューは無言で
 *    前フレームのまま・エクスポートだけが失敗する、という気づけない壊れ方をする。
 *  - pack.png / lock.png と違い **PNG 再エンコードはしない**。背景レイヤの元バイトはパックに
 *    入らず（canvas 合成した background.png だけが出力される）、PNG 化しても出力は 1 バイトも
 *    変わらないのに state / IndexedDB だけが肥大するため（JPEG 写真で数倍〜10 倍）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RestrictToVerticalAxis } from '@dnd-kit/abstract/modifiers';
import {
  Accessibility,
  defaultPreset,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/dom';
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { useTranslation } from 'react-i18next';
import { HexColorPicker } from 'react-colorful';
import { MIN_COORDINATE, expandCell, toSafeInt } from '../core/coords';
import { errMsg } from '../core/errors';
import { hasImageAdjust } from '../core/imageAdjust';
import { maxCornerRadius } from '../core/renderBackground';
import {
  IMAGE_ADJUST_KEYS,
  IMAGE_ADJUST_RANGES,
  SHAPE_KINDS,
  type AreaCell,
  type BackgroundLayer,
  type ColorLayer,
  type GradientLayer,
  type GradientStop,
  type ImageAdjust,
  type ImageLayer,
  type ShapeKind,
  type ShapeLayer,
} from '../core/state';
import { useObjectUrl } from '../hooks/useObjectUrl';
import { notifyUndoable } from '../store/history';
import {
  useWallStore,
  type BackgroundLayerPatch,
} from '../store/useWallStore';
import { CropModal } from './CropModal';
import { Button, Select, Switch, toast } from './ui';
import { cn } from './ui/cn';

// ---------------------------------------------------------------------------
// 共通: 画像ファイルの取り込み
// ---------------------------------------------------------------------------

/**
 * ベクタ画像（SVG / SVGZ）か。`accept="image/*"` は SVG を通すが、`createImageBitmap` は
 * Chromium 系（Chrome / WebView2）で SVG を reject する。Firefox では通ってしまうため、
 * 環境差で「Web では出るがデスクトップでは出ない背景」にならないよう一律で弾く。
 *
 * これ以外の形式はここで判定しない（`file.type` は空や `application/octet-stream` に
 * なり得るので拡張子・MIME での allowlist は誤検知する）。実際に描けるかは
 * `assertDecodable` のデコード結果に委ねる。
 */
function isVectorImageFile(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name);
}

/**
 * バイト列が `createImageBitmap` でデコードできることを検証する（失敗時は throw）。
 * renderBackground の `getCachedBitmap` と**同じ Blob の組み立て方**で検証しないと、
 * ここを通ったのに描画で落ちる、という取りこぼしが起きる。
 */
async function assertDecodable(
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  const bitmap = await createImageBitmap(
    // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
  );
  bitmap.close();
}

// ---------------------------------------------------------------------------
// 共通: 不透明度スライダ
// ---------------------------------------------------------------------------

interface OpacityRowProps {
  value: number; // 0..1
  onChange: (next: number) => void;
}

function OpacityRow({ value, onChange }: OpacityRowProps) {
  const { t } = useTranslation();
  const percent = Math.round(value * 100);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">
          {t('background.opacity')}
        </span>
        <span className="text-xs text-fg-subtle">{percent}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={t('background.opacity')}
        aria-valuetext={`${percent}%`}
        className="w-full cursor-pointer accent-blue-600"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 共通: 整数のスライダ＋数値入力
// ---------------------------------------------------------------------------

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** 数値入力の後ろに付ける単位（px など）。 */
  unit?: string;
  onChange: (next: number) => void;
}

/** 数値入力は [min, max] の整数に丸めて渡す（空欄・不正値は 0）。 */
function SliderRow({ label, value, min, max, unit, onChange }: SliderRowProps) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        <span className="flex items-center gap-1 text-xs text-fg-subtle">
          <input
            type="number"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(toSafeInt(e.target.value, 0, min, max))}
            aria-label={label}
            className="h-6 w-16 rounded border border-border-strong bg-surface px-1.5 text-xs text-fg"
          />
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="w-full cursor-pointer accent-blue-600"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shape 用: 角丸スライダ
// ---------------------------------------------------------------------------

interface CornerRadiusRowProps {
  value: number; // px
  /** 図形に収まる上限 px（maxCornerRadius）。 */
  max: number;
  onChange: (next: number) => void;
}

function CornerRadiusRow({ value, max, onChange }: CornerRadiusRowProps) {
  const { t } = useTranslation();
  // 図形を縮めると保存値が上限を超え得る（描画は上限で丸める）。表示は実際に効いている値にする
  return (
    <SliderRow
      label={t('background.shape.cornerRadius')}
      value={Math.min(value, max)}
      min={0}
      max={max}
      unit="px"
      onChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Image 用: 色調補正・ぼかし
// ---------------------------------------------------------------------------

const NO_IMAGE_ADJUST: ImageAdjust = {
  lightness: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
};

const IMAGE_ADJUST_UNIT: Record<keyof ImageAdjust, string | undefined> = {
  lightness: undefined,
  saturation: undefined,
  hue: '°',
  blur: 'px',
};

function ImageAdjustBox({
  adjust,
  onChange,
}: {
  adjust: ImageAdjust | undefined;
  /** `undefined` で補正なしに戻す。 */
  onChange: (next: ImageAdjust | undefined) => void;
}) {
  const { t } = useTranslation();
  const current = adjust ?? NO_IMAGE_ADJUST;
  return (
    <div className="space-y-2 rounded-md bg-muted p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">
          {t('background.image.adjust.title')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasImageAdjust(adjust)}
          onClick={() => onChange(undefined)}
        >
          {t('background.image.adjust.reset')}
        </Button>
      </div>
      {IMAGE_ADJUST_KEYS.map((key) => (
        <SliderRow
          key={key}
          label={t(`background.image.adjust.${key}`)}
          value={current[key]}
          min={IMAGE_ADJUST_RANGES[key].min}
          max={IMAGE_ADJUST_RANGES[key].max}
          unit={IMAGE_ADJUST_UNIT[key]}
          onChange={(v) => onChange({ ...current, [key]: v })}
        />
      ))}
      <p className="text-xs text-fg-subtle">
        {t('background.image.adjust.hint')}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 共通: 単色の選択（color / shape レイヤ）
// ---------------------------------------------------------------------------

/** カラーピッカーと現在値（色見本 + hex）。親の `space-y-*` に 2 行として並ぶ。 */
function ColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (next: string) => void;
}) {
  return (
    <>
      <div className="flex justify-center">
        <HexColorPicker color={color} onChange={onChange} />
      </div>
      <div className="flex items-center gap-2">
        <span
          className="h-7 w-7 rounded border border-border-strong"
          style={{ background: color }}
        />
        <code className="rounded bg-muted px-2 py-1 text-xs">{color}</code>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Color レイヤ
// ---------------------------------------------------------------------------

function ColorEditor({
  layer,
  onUpdate,
}: {
  layer: ColorLayer;
  onUpdate: (patch: BackgroundLayerPatch) => void;
}) {
  return (
    <div className="space-y-3">
      <ColorField
        color={layer.color}
        onChange={(c) => onUpdate({ type: 'color', color: c })}
      />
      <OpacityRow
        value={layer.opacity}
        onChange={(v) => onUpdate({ type: 'color', opacity: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image レイヤ
// ---------------------------------------------------------------------------

function ImageEditor({
  layer,
  onUpdate,
  onOpenCrop,
}: {
  layer: ImageLayer;
  onUpdate: (patch: BackgroundLayerPatch) => void;
  onOpenCrop: () => void;
}) {
  const { t } = useTranslation();
  const resolution = useWallStore((s) => s.wall.resolution);
  const fitOptions = [
    { value: 'cover', label: t('background.image.fit.cover') },
    { value: 'contain', label: t('background.image.fit.contain') },
    { value: 'stretch', label: t('background.image.fit.stretch') },
    { value: 'manual', label: t('background.image.fit.manual') },
  ];

  const previewUrl = useObjectUrl(layer.source);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // 読み取り + デコード検証中。大きい画像だと秒単位かかるため、二重ピックで
  // 後発の結果が先発に上書きされないようボタンを止める（LockImagesEditor と同じ方針）。
  const [loading, setLoading] = useState(false);

  const handleReplace = async (file: File) => {
    if (isVectorImageFile(file)) {
      toast.error(t('background.toast.notRaster', { filename: file.name }));
      return;
    }
    // ピック後・読み取り前にファイルが消える（USB 取り外し / ネットワーク切断 / 権限剥奪）と
    // arrayBuffer() が reject する。未処理 rejection にせずトーストで通知する。
    const mimeType = file.type || 'image/png';
    let bytes: Uint8Array;
    setLoading(true);
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      await assertDecodable(bytes, mimeType);
    } catch (e) {
      console.error('background image read failed', e);
      toast.error(
        t('background.toast.imageFailed', {
          filename: file.name,
          error: errMsg(e),
        }),
      );
      return;
    } finally {
      setLoading(false);
    }
    onUpdate({
      type: 'image',
      source: {
        kind: 'inline',
        bytes,
        mimeType,
      },
      originalFileName: file.name,
      // crop は旧画像の px 座標なので新画像では画像外を指し得る。transform は wall 座標系なので維持。
      crop: undefined,
    });
  };

  const handleFitChange = (fit: string) => {
    const next = fit as ImageLayer['fit'];
    if (next === 'manual' && !layer.transform) {
      onUpdate({
        type: 'image',
        fit: next,
        transform: {
          x: 0,
          y: 0,
          width: resolution.width,
          height: resolution.height,
        },
      });
    } else {
      onUpdate({ type: 'image', fit: next });
    }
  };

  const handleTransformField =
    (field: 'x' | 'y' | 'width' | 'height') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Math.floor(Number(e.target.value) || 0);
      const cur = layer.transform ?? {
        x: 0,
        y: 0,
        width: resolution.width,
        height: resolution.height,
      };
      const next = { ...cur, [field]: v };
      if (next.width < 1) next.width = 1;
      if (next.height < 1) next.height = 1;
      onUpdate({ type: 'image', transform: next });
    };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className="h-20 w-20 rounded border border-border-strong bg-surface object-cover"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded border border-dashed border-border-strong text-xs text-fg-subtle">
            {t('background.image.none')}
          </div>
        )}
        {/* 他のボタン列（レイヤ追加など）と同じ gap-2 で並べる */}
        <div className="flex flex-1 flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleReplace(f);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => fileInputRef.current?.click()}
          >
            {t('background.image.replace')}
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenCrop}>
            {t('background.image.crop')}
          </Button>
        </div>
      </div>

      <Select
        label={t('background.image.fitMode')}
        value={layer.fit}
        onValueChange={handleFitChange}
        options={fitOptions}
      />

      {layer.fit === 'manual' && (
        <div className="rounded-md bg-violet-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-violet-800">
              {t('background.image.manualTitle')}
            </span>
            <span className="text-xs text-violet-600">
              {t('background.image.manualHint')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-violet-700">
              {t('areaEditor.x')}
              <input
                type="number"
                value={layer.transform?.x ?? 0}
                onChange={handleTransformField('x')}
                className="mt-0.5 h-8 w-full rounded border border-violet-300 px-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-violet-700">
              {t('areaEditor.y')}
              <input
                type="number"
                value={layer.transform?.y ?? 0}
                onChange={handleTransformField('y')}
                className="mt-0.5 h-8 w-full rounded border border-violet-300 px-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-violet-700">
              {t('areaEditor.width')}
              <input
                type="number"
                min={1}
                value={layer.transform?.width ?? resolution.width}
                onChange={handleTransformField('width')}
                className="mt-0.5 h-8 w-full rounded border border-violet-300 px-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-violet-700">
              {t('areaEditor.height')}
              <input
                type="number"
                min={1}
                value={layer.transform?.height ?? resolution.height}
                onChange={handleTransformField('height')}
                className="mt-0.5 h-8 w-full rounded border border-violet-300 px-1.5 text-xs"
              />
            </label>
          </div>
        </div>
      )}

      <ImageAdjustBox
        adjust={layer.adjust}
        onChange={(adjust) => onUpdate({ type: 'image', adjust })}
      />

      <OpacityRow
        value={layer.opacity}
        onChange={(v) => onUpdate({ type: 'image', opacity: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gradient レイヤ
// ---------------------------------------------------------------------------

function GradientEditor({
  layer,
  onUpdate,
}: {
  layer: GradientLayer;
  onUpdate: (patch: BackgroundLayerPatch) => void;
}) {
  const { t } = useTranslation();
  const [activeStop, setActiveStop] = useState(0);
  const safeActive = Math.min(activeStop, layer.stops.length - 1);

  const updateStops = (stops: GradientStop[]) =>
    onUpdate({ type: 'gradient', stops });

  const handleStopColor = (color: string) => {
    const next = layer.stops.map((s, i) =>
      i === safeActive ? { ...s, color } : s,
    );
    updateStops(next);
  };

  const handleStopOffset = (i: number, offset: number) => {
    const next = layer.stops.map((s, idx) =>
      idx === i ? { ...s, offset } : s,
    );
    updateStops(next);
  };

  const handleAddStop = () => {
    const next = [
      ...layer.stops,
      { offset: 0.5, color: '#888888' },
    ].sort((a, b) => a.offset - b.offset);
    updateStops(next);
  };

  const handleRemoveStop = (i: number) => {
    if (layer.stops.length <= 2) return;
    const next = layer.stops.filter((_, idx) => idx !== i);
    updateStops(next);
    if (safeActive >= next.length) setActiveStop(next.length - 1);
  };

  const gradientPreview = useMemo(() => {
    const sorted = [...layer.stops].sort((a, b) => a.offset - b.offset);
    const css = sorted
      .map((s) => `${s.color} ${Math.round(s.offset * 100)}%`)
      .join(', ');
    return `linear-gradient(${layer.angle}deg, ${css})`;
  }, [layer.stops, layer.angle]);

  const active = layer.stops[safeActive];

  return (
    <div className="space-y-3">
      <div
        className="h-16 rounded border border-border-strong"
        style={{ background: gradientPreview }}
      />

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">
            {t('background.gradient.angle')}
          </span>
          <span className="text-xs text-fg-subtle">{layer.angle}°</span>
        </div>
        <input
          type="range"
          min={0}
          max={360}
          value={layer.angle}
          onChange={(e) =>
            onUpdate({ type: 'gradient', angle: Number(e.target.value) })
          }
          aria-label={t('background.gradient.angle')}
          aria-valuetext={`${layer.angle}°`}
          className="w-full cursor-pointer accent-blue-600"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">
            {t('background.gradient.stopsTitle', { count: layer.stops.length })}
          </span>
          <Button size="sm" variant="outline" onClick={handleAddStop}>
            {t('background.gradient.addStop')}
          </Button>
        </div>
        <ul className="mb-2 space-y-1">
          {layer.stops.map((stop, i) => (
            <li
              key={i}
              className={cn(
                'flex items-center gap-2 rounded border px-2 py-1',
                i === safeActive
                  ? 'border-blue-400 bg-accent-soft'
                  : 'border-border bg-surface',
              )}
            >
              <button
                type="button"
                onClick={() => setActiveStop(i)}
                className="h-5 w-5 flex-shrink-0 cursor-pointer rounded border border-border-strong"
                style={{ background: stop.color }}
                aria-label={t('background.gradient.selectStopAria', { n: i + 1 })}
              />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(stop.offset * 100)}
                onChange={(e) =>
                  handleStopOffset(i, Number(e.target.value) / 100)
                }
                aria-label={t('background.gradient.stopOffsetAria', { n: i + 1 })}
                aria-valuetext={`${Math.round(stop.offset * 100)}%`}
                className="flex-1 cursor-pointer accent-blue-600"
              />
              <span className="w-10 text-right text-xs text-fg-subtle">
                {Math.round(stop.offset * 100)}%
              </span>
              <button
                type="button"
                disabled={layer.stops.length <= 2}
                onClick={() => handleRemoveStop(i)}
                className="cursor-pointer text-xs text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={t('background.delete')}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {active && (
          <div>
            <p className="mb-1 text-xs text-fg-subtle">
              {t('background.gradient.stopColorPrompt', { n: safeActive + 1 })}
            </p>
            <div className="flex justify-center">
              <HexColorPicker
                color={active.color}
                onChange={handleStopColor}
              />
            </div>
          </div>
        )}
      </div>

      <OpacityRow
        value={layer.opacity}
        onChange={(v) => onUpdate({ type: 'gradient', opacity: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shape レイヤ
// ---------------------------------------------------------------------------

/**
 * 図形をエリア（＋余白）に合わせる。適用時点のスナップショットで、エリアとは連動しない。
 * layout の購読をここに閉じ、エリアのドラッグ中に ShapeEditor（カラーピッカー等）ごと
 * 再描画しないようにする。
 */
function FitToAreaBox({ onFit }: { onFit: (transform: AreaCell) => void }) {
  const { t } = useTranslation();
  const layout = useWallStore((s) => s.wall.layout);
  // 対象と余白は図形を切り替えても引き継ぐ（同じ余白で並べる用途が多いため）
  const [fitTarget, setFitTarget] = useState('main');
  const [fitPadding, setFitPadding] = useState(0);

  // 非表示の locked / preparing はパックに出ない（ゲームに存在しない）ので候補から外す
  const fitOptions = [
    { value: 'main', label: 'main', cell: layout.main },
    ...(layout.locked.show
      ? [{ value: 'locked', label: 'locked', cell: layout.locked }]
      : []),
    ...layout.preparing.flatMap((p, i) =>
      p.show
        ? [
            {
              value: `preparing:${i}`,
              label: t('layoutEditor.preparingNumbered', { n: i + 1 }),
              cell: p,
            },
          ]
        : [],
    ),
  ].map((o) => ({ ...o, hint: `${o.cell.width}×${o.cell.height}` }));
  // 選んでいたエリアが非表示・削除になったら main に戻す
  const fitSelected =
    fitOptions.find((o) => o.value === fitTarget) ?? fitOptions[0];

  return (
    <div className="space-y-2 rounded-md bg-muted p-3">
      <span className="text-xs font-medium text-fg-muted">
        {t('background.shape.fitTitle')}
      </span>
      <Select
        label={t('background.shape.fitArea')}
        value={fitSelected.value}
        onValueChange={setFitTarget}
        options={fitOptions}
      />
      <div className="flex items-end gap-2">
        <label className="flex-1 text-xs text-fg-muted">
          {t('background.shape.fitPadding')}
          <span className="mt-0.5 flex items-center gap-1">
            <input
              type="number"
              value={fitPadding}
              onChange={(e) =>
                setFitPadding(toSafeInt(e.target.value, 0, MIN_COORDINATE))
              }
              className="h-8 w-full rounded border border-border-strong bg-surface px-1.5 text-xs text-fg"
            />
            px
          </span>
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onFit(expandCell(fitSelected.cell, fitPadding))}
        >
          {t('background.shape.fitApply')}
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">
        {t('background.shape.fitHint')}
      </p>
    </div>
  );
}

function ShapeEditor({
  layer,
  onUpdate,
}: {
  layer: ShapeLayer;
  onUpdate: (patch: BackgroundLayerPatch) => void;
}) {
  const { t } = useTranslation();
  const shapeOptions = SHAPE_KINDS.map((kind) => ({
    value: kind,
    label: t(`background.shape.kind.${kind}`),
  }));

  // 整数化と幅・高さ 1 以上はストア（floorLayerNumbers）が保証する
  const handleTransformField =
    (field: 'x' | 'y' | 'width' | 'height') =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onUpdate({
        type: 'shape',
        transform: { ...layer.transform, [field]: Number(e.target.value) },
      });

  // 高さを幅に揃える（正方形・正円にする）
  const handleSquare = () =>
    onUpdate({
      type: 'shape',
      transform: { ...layer.transform, height: layer.transform.width },
    });

  const fields = [
    { key: 'x', label: t('areaEditor.x'), min: undefined },
    { key: 'y', label: t('areaEditor.y'), min: undefined },
    { key: 'width', label: t('areaEditor.width'), min: 1 },
    { key: 'height', label: t('areaEditor.height'), min: 1 },
  ] as const;

  return (
    <div className="space-y-3">
      <Select
        label={t('background.shape.kindLabel')}
        value={layer.shape}
        onValueChange={(v) =>
          onUpdate({ type: 'shape', shape: v as ShapeKind })
        }
        options={shapeOptions}
      />

      <ColorField
        color={layer.color}
        onChange={(c) => onUpdate({ type: 'shape', color: c })}
      />

      <div className="rounded-md bg-muted p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">
            {t('background.shape.boundsTitle')}
          </span>
          <span className="text-xs text-fg-subtle">
            {t('background.image.manualHint')}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {fields.map((f) => (
            <label key={f.key} className="text-xs text-fg-muted">
              {f.label}
              <input
                type="number"
                min={f.min}
                value={layer.transform[f.key]}
                onChange={handleTransformField(f.key)}
                className="mt-0.5 h-8 w-full rounded border border-border-strong bg-surface px-1.5 text-xs text-fg"
              />
            </label>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={handleSquare}
        >
          {t('background.shape.square')}
        </Button>
      </div>

      <FitToAreaBox
        onFit={(transform) => onUpdate({ type: 'shape', transform })}
      />

      {/* 円には角が無いので出さない（値は保持し、種類を戻すと復帰する） */}
      {layer.shape !== 'ellipse' && (
        <CornerRadiusRow
          value={layer.cornerRadius ?? 0}
          max={maxCornerRadius(layer)}
          onChange={(v) => onUpdate({ type: 'shape', cornerRadius: v })}
        />
      )}

      <OpacityRow
        value={layer.opacity}
        onChange={(v) => onUpdate({ type: 'shape', opacity: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LayerListItem — レイヤ一覧の 1 行
// ---------------------------------------------------------------------------

const TYPE_COLOR: Record<BackgroundLayer['type'], string> = {
  color: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  image: 'bg-violet-100 text-violet-700 border-violet-300',
  gradient: 'bg-amber-100 text-amber-700 border-amber-300',
  shape: 'bg-sky-100 text-sky-700 border-sky-300',
};

/**
 * レイヤ 1 行の見出し文字列を組み立てる。
 *  - color    : `#rrggbb` 値そのまま
 *  - gradient : `角度° / N stops`
 *  - image    : 元ファイル名 ／ 無ければ「画像 (xx KB)」
 *  - shape    : `図形名 幅×高さ`
 */
function layerHeadline(
  layer: BackgroundLayer,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (layer.type) {
    case 'color':
      return layer.color;
    case 'gradient':
      return `${layer.angle}° / ${layer.stops.length} stops`;
    case 'image':
      if (layer.originalFileName) return layer.originalFileName;
      if (layer.source.kind === 'inline')
        return t('background.gradient.fileImage', {
          size: (layer.source.bytes.byteLength / 1024).toFixed(1),
        });
      return t('background.gradient.imageRef');
    case 'shape':
      return `${t(`background.shape.kind.${layer.shape}`)} ${layer.transform.width}×${layer.transform.height}`;
  }
}

/** 並び替えの読み上げで使う、各行の sortable に載せる値。 */
interface LayerDragData {
  name: string;
  total: number;
}

/** 縦 2 列 × 3 段の点。ドラッグのつまみ。 */
function GripIcon() {
  return (
    <svg viewBox="0 0 10 16" className="h-4 w-2.5" fill="currentColor" aria-hidden>
      {[3, 8, 13].map((cy) => (
        <g key={cy}>
          <circle cx="2.5" cy={cy} r="1.5" />
          <circle cx="7.5" cy={cy} r="1.5" />
        </g>
      ))}
    </svg>
  );
}

interface LayerListItemProps {
  layer: BackgroundLayer;
  /** 一覧での位置（0 = 一番上 = 最も手前）。 */
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onVisibleChange: (next: boolean) => void;
  onDelete: () => void;
}

function LayerListItem({
  layer,
  index,
  total,
  selected,
  onSelect,
  onVisibleChange,
  onDelete,
}: LayerListItemProps) {
  const { t } = useTranslation();
  const headline = layerHeadline(layer, t);
  const typeLabel = t(`background.type.${layer.type}`);
  const name = `${typeLabel} ${headline}`;
  // つまみ（handleRef）からだけドラッグを始める。行全体にすると、Switch や見出しの
  // クリック・テキスト選択とドラッグの開始がぶつかるため。
  const { ref, handleRef, isDragging } = useSortable({
    id: layer.id,
    index,
    data: { name, total } satisfies LayerDragData,
  });

  // 選択は「種別＋見出し」のボタンで行う。行全体を role=button にすると、中の Switch や
  // 並び替え・削除が入れ子の操作になり、支援技術から個別に扱えなくなるため。
  return (
    <li
      ref={ref}
      className={cn(
        'group flex items-center gap-2 rounded-md border bg-surface p-2 transition-colors',
        isDragging && 'relative z-10 shadow-lg',
        selected
          ? // ring-blue-100 はダーク面（neutral-900）で白く浮くため、
            // ダークのみ半透明ブルーのハローに切り替える。
            'border-blue-400 ring-2 ring-blue-100 dark:border-blue-500 dark:ring-blue-500/30'
          : 'border-border hover:border-border-strong hover:bg-muted',
      )}
      title={headline}
    >
      <button
        ref={handleRef}
        type="button"
        data-drag-handle={layer.id}
        aria-label={t('background.dragHandle', { name })}
        // 未指定だと dnd-kit が英語の "draggable" を入れる
        aria-roledescription={t('background.dnd.roleDescription')}
        className="-ml-1 flex h-7 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded text-fg-subtle hover:bg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 active:cursor-grabbing"
      >
        <GripIcon />
      </button>
      {/* ラッパーを flex 化。inline のままだと中の Switch がベースラインに乗り、
          下にディセンダ分の余白ができて上寄りに見えるため。 */}
      <span className="flex flex-shrink-0 items-center">
        <Switch
          checked={layer.visible}
          onChange={onVisibleChange}
          aria-label={t('background.layerVisible', { name })}
        />
      </span>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span
          className={cn(
            'flex-shrink-0 rounded border px-1.5 py-0.5 text-xs font-semibold',
            TYPE_COLOR[layer.type],
          )}
        >
          {typeLabel}
        </span>
        {/* 読み上げ名で種別と見出しがつながらないように（flex 内の空白は描画されない） */}{' '}
        <span className="flex-1 truncate text-xs text-fg-muted group-hover:text-fg">
          {headline}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="h-7 w-7 flex-shrink-0 cursor-pointer rounded text-xs text-red-600 hover:bg-red-50"
        title={t('background.delete')}
        aria-label={t('background.delete')}
      >
        ×
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// BackgroundEditor 本体
// ---------------------------------------------------------------------------

// DragDropProvider は modifiers / plugins が別の配列になるたびに manager へ入れ直すので、
// 毎レンダー作らない。
const DND_MODIFIERS = [RestrictToVerticalAxis];

export function BackgroundEditor() {
  const { t } = useTranslation();
  const layers = useWallStore((s) => s.wall.background.layers);
  const resolution = useWallStore((s) => s.wall.resolution);
  const selectedLayerId = useWallStore((s) => s.ui.selectedBackgroundLayerId);
  const addBackgroundLayer = useWallStore((s) => s.addBackgroundLayer);
  const removeBackgroundLayer = useWallStore((s) => s.removeBackgroundLayer);
  const updateBackgroundLayer = useWallStore((s) => s.updateBackgroundLayer);
  const reorderBackgroundLayers = useWallStore(
    (s) => s.reorderBackgroundLayers,
  );
  const selectBackgroundLayer = useWallStore((s) => s.selectBackgroundLayer);

  const addImageInputRef = useRef<HTMLInputElement>(null);
  // 読み取り + デコード検証中は追加ボタンを止める（二重ピックでの取りこぼし防止）。
  const [addingImage, setAddingImage] = useState(false);

  const [cropTargetId, setCropTargetId] = useState<string | null>(null);
  const cropTarget = useMemo(() => {
    if (!cropTargetId) return null;
    const l = layers.find((x) => x.id === cropTargetId);
    return l && l.type === 'image' ? l : null;
  }, [layers, cropTargetId]);

  const selectedLayer = useMemo(() => {
    if (!selectedLayerId) return null;
    return layers.find((l) => l.id === selectedLayerId) ?? null;
  }, [layers, selectedLayerId]);

  const handleAddColor = () => {
    const id = crypto.randomUUID();
    addBackgroundLayer({
      id,
      type: 'color',
      color: '#ffffff',
      opacity: 1,
      visible: true,
    });
    selectBackgroundLayer(id);
  };

  const handleAddImage = async (file: File) => {
    if (isVectorImageFile(file)) {
      toast.error(t('background.toast.notRaster', { filename: file.name }));
      return;
    }
    // ピック後・読み取り前にファイルが消える（USB 取り外し / ネットワーク切断 / 権限剥奪）と
    // arrayBuffer() が reject する。未処理 rejection にせずトーストで通知する。
    const mimeType = file.type || 'image/png';
    let bytes: Uint8Array;
    setAddingImage(true);
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      await assertDecodable(bytes, mimeType);
    } catch (e) {
      console.error('background image read failed', e);
      toast.error(
        t('background.toast.imageFailed', {
          filename: file.name,
          error: errMsg(e),
        }),
      );
      return;
    } finally {
      setAddingImage(false);
    }
    const id = crypto.randomUUID();
    addBackgroundLayer({
      id,
      type: 'image',
      source: {
        kind: 'inline',
        bytes,
        mimeType,
      },
      opacity: 1,
      visible: true,
      fit: 'cover',
      originalFileName: file.name,
    });
    selectBackgroundLayer(id);
  };

  const handleAddGradient = () => {
    const id = crypto.randomUUID();
    addBackgroundLayer({
      id,
      type: 'gradient',
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 1, color: '#ffffff' },
      ],
      angle: 0,
      opacity: 1,
      visible: true,
    });
    selectBackgroundLayer(id);
  };

  const handleAddShape = () => {
    const id = crypto.randomUUID();
    // 初期配置は解像度の 1/4 サイズで中央
    const width = Math.max(1, Math.floor(resolution.width / 4));
    const height = Math.max(1, Math.floor(resolution.height / 4));
    addBackgroundLayer({
      id,
      type: 'shape',
      shape: 'rect',
      color: '#ffffff',
      transform: {
        x: Math.floor((resolution.width - width) / 2),
        y: Math.floor((resolution.height - height) / 2),
        width,
        height,
      },
      opacity: 1,
      visible: true,
    });
    selectBackgroundLayer(id);
  };

  // 一覧は上ほど手前。state（描画順）は先頭が奥なので、表示だけ反転する。
  const listedLayers = useMemo(() => layers.slice().reverse(), [layers]);

  // 置いた後、行の並び替えでつまみからフォーカスが外れるので、動かした行のつまみへ戻す
  // （キーボードで続けて操作できるように）。
  const refocusHandleRef = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusHandleRef.current;
    if (!id) return;
    refocusHandleRef.current = null;
    document
      .querySelector<HTMLElement>(`[data-drag-handle="${CSS.escape(id)}"]`)
      ?.focus();
  }, [layers]);

  // 読み上げの文言。レイヤ名と総数は各行の sortable の data（LayerDragData）から読む
  // （plugins を作り直すと manager のプラグインが差し替わるため、依存は t だけにする）。
  const dndPlugins = useMemo(() => {
    const announce = (
      key: 'picked' | 'moved' | 'dropped',
      source: DragStartEvent['operation']['source'],
    ) => {
      if (!isSortable(source)) return undefined;
      const data = source.data as LayerDragData;
      return t(`background.dnd.${key}`, {
        name: data.name,
        position: source.index + 1,
        total: data.total,
      });
    };
    return [
      ...defaultPreset.plugins.filter((p) => p !== Accessibility),
      Accessibility.configure({
        screenReaderInstructions: { draggable: t('background.dnd.instructions') },
        announcements: {
          dragstart: ({ operation }: DragStartEvent) =>
            announce('picked', operation.source),
          dragover: ({ operation }: DragOverEvent) =>
            announce('moved', operation.source),
          dragend: ({ operation, canceled }: DragEndEvent) =>
            canceled
              ? t('background.dnd.canceled', {
                  name: (operation.source?.data as LayerDragData | undefined)
                    ?.name,
                })
              : announce('dropped', operation.source),
        },
      }),
    ];
  }, [t]);

  const handleVisibleChange = (layer: BackgroundLayer, next: boolean) => {
    // 判別共用体の `type` ごとに patch 型が変わるが、`visible` 単独更新は
    // どの分岐でも同じ shape。`as` で patch 型を整える 1 行で済む。
    updateBackgroundLayer(layer.id, {
      type: layer.type,
      visible: next,
    } as BackgroundLayerPatch);
  };

  // Editor 部分の見出し
  const editorTitle = selectedLayer
    ? t('background.editLayer', {
        type: t(`background.type.${selectedLayer.type}`),
      })
    : t('background.selectLayer');

  return (
    <>
      {/* パネル全体が 1 本のスクロールに乗る。一覧と編集欄で高さを取り合わせると、
          背の低いウィンドウ（Desktop 既定の 800×600 など）で一覧が 0 まで潰れるため。 */}
      <div className="flex flex-col gap-3">
        {/* 上段: 追加ボタン群 */}
        <section className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handleAddColor}>
              {t('background.addColor')}
            </Button>
            <input
              ref={addImageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleAddImage(f);
                if (addImageInputRef.current)
                  addImageInputRef.current.value = '';
              }}
            />
            <Button
              size="sm"
              disabled={addingImage}
              onClick={() => addImageInputRef.current?.click()}
            >
              {t('background.addImage')}
            </Button>
            <Button size="sm" onClick={handleAddGradient}>
              {t('background.addGradient')}
            </Button>
            <Button size="sm" onClick={handleAddShape}>
              {t('background.addShape')}
            </Button>
          </div>
          <p className="text-xs text-fg-subtle">
            {t('background.drawOrderHint')}
          </p>
        </section>

        {/* 中段: レイヤ一覧（多いときは一覧の中でスクロール） */}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">
            {t('background.layerListTitle', { count: layers.length })}
          </h3>
          {layers.length > 0 && (
            <p className="text-xs text-fg-subtle">
              {t('background.visibilityHint')}
            </p>
          )}
          {layers.length === 0 ? (
            <p className="rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
              {t('background.layerListEmpty')}
            </p>
          ) : (
            <DragDropProvider
              modifiers={DND_MODIFIERS}
              plugins={dndPlugins}
              onDragEnd={(event) => {
                if (event.canceled) return;
                const { source } = event.operation;
                if (!isSortable(source) || source.initialIndex === source.index)
                  return;
                const ids = listedLayers.map((l) => l.id);
                const [moved] = ids.splice(source.initialIndex, 1);
                ids.splice(source.index, 0, moved);
                refocusHandleRef.current = moved;
                reorderBackgroundLayers(ids.reverse());
              }}
            >
              <ul className="flex max-h-[min(40vh,20rem)] flex-col gap-2 overflow-y-auto pr-1">
                {listedLayers.map((layer, i) => (
                  <LayerListItem
                    key={layer.id}
                    layer={layer}
                    index={i}
                    total={listedLayers.length}
                    selected={selectedLayerId === layer.id}
                    onSelect={() =>
                      selectBackgroundLayer(
                        selectedLayerId === layer.id ? null : layer.id,
                      )
                    }
                    onVisibleChange={(b) => handleVisibleChange(layer, b)}
                    onDelete={() => {
                      removeBackgroundLayer(layer.id);
                      notifyUndoable(t('history.deleted.layer'));
                    }}
                  />
                ))}
              </ul>
            </DragDropProvider>
          )}
        </section>

        {/* 下段: 選択中レイヤのエディタ */}
        <section className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-sm font-semibold text-fg">
            {editorTitle}
          </h3>
          {selectedLayer ? (
            <div className="rounded-md border border-border bg-panel p-3">
              {selectedLayer.type === 'color' && (
                <ColorEditor
                  layer={selectedLayer}
                  onUpdate={(p) => updateBackgroundLayer(selectedLayer.id, p)}
                />
              )}
              {selectedLayer.type === 'image' && (
                <ImageEditor
                  layer={selectedLayer}
                  onUpdate={(p) => updateBackgroundLayer(selectedLayer.id, p)}
                  onOpenCrop={() => setCropTargetId(selectedLayer.id)}
                />
              )}
              {selectedLayer.type === 'gradient' && (
                <GradientEditor
                  layer={selectedLayer}
                  onUpdate={(p) => updateBackgroundLayer(selectedLayer.id, p)}
                />
              )}
              {selectedLayer.type === 'shape' && (
                <ShapeEditor
                  layer={selectedLayer}
                  onUpdate={(p) => updateBackgroundLayer(selectedLayer.id, p)}
                />
              )}
            </div>
          ) : (
            <p className="rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
              {t('background.selectPrompt')}
            </p>
          )}
        </section>
      </div>

      {cropTarget && (
        <CropModal
          layer={cropTarget}
          onClose={() => setCropTargetId(null)}
          onApply={(crop) => {
            updateBackgroundLayer(cropTarget.id, { type: 'image', crop });
            setCropTargetId(null);
          }}
        />
      )}
    </>
  );
}
