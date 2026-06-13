/**
 * BackgroundEditor — background.layers の追加・編集・並び替え・削除。
 *
 * 仕様: REWRITE_SPEC.md 第4.2章（Canvas 合成）/ 第7.1章（判別共用体）。
 *  - 配列の先頭が「奥」、末尾が「手前」（buildPack/renderBackground の描画順と一致）。
 *  - 全ての state mutation は `updateBackgroundLayer(id, patch)` で型安全に。
 *  - color/image/gradient の判別は patch.type で narrow される。
 *
 * UI: アコーディオンを廃止し、上部レイヤ一覧 + 下部エディタの master-detail 構造に変更。
 *  - 選択中レイヤは store の `ui.selectedBackgroundLayerId` を共有
 *    （image+manual のときプレビュー操作モードも兼ねる）。
 *  - image レイヤのヘッダにはファイル名を表示。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HexColorPicker } from 'react-colorful';
import type {
  BackgroundLayer,
  ColorLayer,
  GradientLayer,
  GradientStop,
  ImageLayer,
} from '../core/state';
import {
  useWallStore,
  type BackgroundLayerPatch,
} from '../store/useWallStore';
import { CropModal } from './CropModal';
import { Button, Select, Switch } from './ui';
import { cn } from './ui/cn';

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
        className="w-full cursor-pointer accent-blue-600"
      />
    </div>
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
      <div className="flex justify-center">
        <HexColorPicker
          color={layer.color}
          onChange={(c) => onUpdate({ type: 'color', color: c })}
        />
      </div>
      <div className="flex items-center gap-2">
        <span
          className="h-7 w-7 rounded border border-border-strong"
          style={{ background: layer.color }}
        />
        <code className="rounded bg-muted px-2 py-1 text-xs">
          {layer.color}
        </code>
      </div>
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

  const previewUrl = useMemo(() => {
    if (layer.source.kind !== 'inline') return null;
    return URL.createObjectURL(
      new Blob([layer.source.bytes], {
        type: layer.source.mimeType ?? 'image/png',
      }),
    );
  }, [layer.source]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReplace = async (file: File) => {
    const buf = await file.arrayBuffer();
    onUpdate({
      type: 'image',
      source: {
        kind: 'inline',
        bytes: new Uint8Array(buf),
        mimeType: file.type || 'image/png',
      },
      originalFileName: file.name,
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
          <div className="flex h-20 w-20 items-center justify-center rounded border border-dashed border-border-strong text-[10px] text-fg-subtle">
            {t('background.image.none')}
          </div>
        )}
        <div className="flex-1 space-y-2">
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
            <span className="text-[11px] text-violet-600">
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
// LayerListItem — レイヤ一覧の 1 行
// ---------------------------------------------------------------------------

const TYPE_COLOR: Record<BackgroundLayer['type'], string> = {
  color: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  image: 'bg-violet-100 text-violet-700 border-violet-300',
  gradient: 'bg-amber-100 text-amber-700 border-amber-300',
};

/**
 * レイヤ 1 行の見出し文字列を組み立てる。
 *  - color    : `#rrggbb` 値そのまま
 *  - gradient : `角度° / N stops`
 *  - image    : 元ファイル名 ／ 無ければ「画像 (xx KB)」
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
  }
}

interface LayerListItemProps {
  layer: BackgroundLayer;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onVisibleChange: (next: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function LayerListItem({
  layer,
  index,
  total,
  selected,
  onSelect,
  onVisibleChange,
  onMoveUp,
  onMoveDown,
  onDelete,
}: LayerListItemProps) {
  const { t } = useTranslation();
  const headline = layerHeadline(layer, t);
  // アクション系（visible toggle / 並び替え / 削除）はクリックを行全体まで伝搬させない
  const stop = (e: React.MouseEvent | React.PointerEvent | React.KeyboardEvent) => {
    e.stopPropagation();
  };

  return (
    <li
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md border bg-surface p-2 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        selected
          ? 'border-blue-400 ring-2 ring-blue-100'
          : 'border-border hover:border-border-strong hover:bg-muted',
      )}
      title={headline}
    >
      <span onClick={stop} onPointerDown={stop}>
        <Switch checked={layer.visible} onChange={onVisibleChange} />
      </span>
      <span
        className={cn(
          'flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold',
          TYPE_COLOR[layer.type],
        )}
      >
        {t(`background.type.${layer.type}`)}
      </span>
      <span className="flex-1 truncate text-left text-xs text-fg-muted group-hover:text-fg">
        {headline}
      </span>
      <div
        className="flex flex-shrink-0 items-center gap-0.5"
        onClick={stop}
        onPointerDown={stop}
      >
        <button
          type="button"
          disabled={index === 0}
          onClick={onMoveUp}
          className="h-7 w-7 cursor-pointer rounded text-xs text-fg-subtle hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
          title={t('background.moveBack')}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={index === total - 1}
          onClick={onMoveDown}
          className="h-7 w-7 cursor-pointer rounded text-xs text-fg-subtle hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
          title={t('background.moveFront')}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="h-7 w-7 cursor-pointer rounded text-xs text-red-600 hover:bg-red-50"
          title={t('background.delete')}
        >
          ×
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// BackgroundEditor 本体
// ---------------------------------------------------------------------------

export function BackgroundEditor() {
  const { t } = useTranslation();
  const layers = useWallStore((s) => s.wall.background.layers);
  const selectedLayerId = useWallStore((s) => s.ui.selectedBackgroundLayerId);
  const addBackgroundLayer = useWallStore((s) => s.addBackgroundLayer);
  const removeBackgroundLayer = useWallStore((s) => s.removeBackgroundLayer);
  const updateBackgroundLayer = useWallStore((s) => s.updateBackgroundLayer);
  const reorderBackgroundLayers = useWallStore(
    (s) => s.reorderBackgroundLayers,
  );
  const selectBackgroundLayer = useWallStore((s) => s.selectBackgroundLayer);

  const addImageInputRef = useRef<HTMLInputElement>(null);

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
    const buf = await file.arrayBuffer();
    const id = crypto.randomUUID();
    addBackgroundLayer({
      id,
      type: 'image',
      source: {
        kind: 'inline',
        bytes: new Uint8Array(buf),
        mimeType: file.type || 'image/png',
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

  const moveUp = (i: number) => {
    if (i === 0) return;
    const ids = layers.map((l) => l.id);
    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    reorderBackgroundLayers(ids);
  };
  const moveDown = (i: number) => {
    if (i === layers.length - 1) return;
    const ids = layers.map((l) => l.id);
    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
    reorderBackgroundLayers(ids);
  };

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
      <div className="flex h-full flex-col gap-3">
        {/* 上段: 追加ボタン群（固定） */}
        <section className="flex-shrink-0 space-y-2">
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
            <Button size="sm" onClick={() => addImageInputRef.current?.click()}>
              {t('background.addImage')}
            </Button>
            <Button size="sm" onClick={handleAddGradient}>
              {t('background.addGradient')}
            </Button>
          </div>
          <p className="text-[11px] text-fg-subtle">
            {t('background.drawOrderHint')}
          </p>
        </section>

        {/* 中段: レイヤ一覧（スクロール） */}
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <h3 className="flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {t('background.layerListTitle', { count: layers.length })}
          </h3>
          {layers.length === 0 ? (
            <p className="flex-shrink-0 rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
              {t('background.layerListEmpty')}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {layers.map((layer, i) => (
                <LayerListItem
                  key={layer.id}
                  layer={layer}
                  index={i}
                  total={layers.length}
                  selected={selectedLayerId === layer.id}
                  onSelect={() =>
                    selectBackgroundLayer(
                      selectedLayerId === layer.id ? null : layer.id,
                    )
                  }
                  onVisibleChange={(b) => handleVisibleChange(layer, b)}
                  onMoveUp={() => moveUp(i)}
                  onMoveDown={() => moveDown(i)}
                  onDelete={() => removeBackgroundLayer(layer.id)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* 下段: エディタ（固定・必要なら内部スクロール） */}
        <section className="flex max-h-[55%] flex-shrink-0 flex-col gap-2 border-t border-border pt-3">
          <h3 className="flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {editorTitle}
          </h3>
          {selectedLayer ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-panel p-3">
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
            </div>
          ) : (
            <p className="flex-shrink-0 rounded border border-dashed border-border-strong p-3 text-xs text-fg-subtle">
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
