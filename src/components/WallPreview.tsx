/**
 * WallPreview — state.resolution のアスペクト比に追従するプレビュー。
 *
 *  - 背景は別コンポーネント `BackgroundCanvas` に分離。
 *    `background` / `resolution` の参照変化時のみ Canvas を再描画する（Phase 4d 最適化）。
 *  - エリア（main / locked / preparing[i]）はドラッグ移動・8 ハンドルでリサイズ。
 *  - 選択中の画像レイヤ（`fit:'manual'`）も同様に move/resize。
 *  - スナップ: 他エリア辺・中央・キャンバス端と中央へ磁着（プレビュー基準 6px）。Shift で無効化。
 *  - ドラッグ中は `x,y / w×h` のオーバーレイ表示。
 *
 * 不変条件: 全 state mutation は store アクション経由（座標は store 側で `floorArea`/`floorCell`）。
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { floorCell, realToPreview } from '../core/coords';
import { renderBackgroundToCanvas } from '../core/renderBackground';
import type {
  AreaCell,
  ImageLayer,
  MainArea,
  Resolution,
  VisibleArea,
  WallState,
} from '../core/state';
import { useWallStore } from '../store/useWallStore';
import { snapMove, snapResize, type Handle } from './snap';
import { cn } from './ui/cn';

// ---------------------------------------------------------------------------
// 操作対象の識別子
// ---------------------------------------------------------------------------

type AreaRef =
  | { kind: 'main' }
  | { kind: 'locked' }
  | { kind: 'preparing'; index: number }
  | { kind: 'layer'; layerId: string };

type Mode = { type: 'move' } | { type: 'resize'; handle: Handle };

interface DragState {
  ref: AreaRef;
  mode: Mode;
  startClientX: number;
  startClientY: number;
  startCell: AreaCell;
  pxToRealX: number;
  pxToRealY: number;
}

const HANDLE_LIST: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP_PX_PREVIEW = 6;
const MIN_SIZE = 1;

const handleClass: Record<Handle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  s: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

// ---------------------------------------------------------------------------
// 背景キャンバス（独立コンポーネント、background / resolution 変化時のみ再描画）
// ---------------------------------------------------------------------------

interface BackgroundCanvasProps {
  background: WallState['background'];
  resolution: Resolution;
}

const BackgroundCanvas = memo(function BackgroundCanvas({
  background,
  resolution,
}: BackgroundCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = resolution.width;
    canvas.height = resolution.height;
    let cancelled = false;
    void renderBackgroundToCanvas(canvas, background, resolution).catch((e) => {
      if (!cancelled) console.error('background render failed', e);
    });
    return () => {
      cancelled = true;
    };
  }, [background, resolution]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ width: '100%', height: '100%' }}
    />
  );
});

// ---------------------------------------------------------------------------
// 既存セルからハンドル方向の delta を当てて新セルを計算
// ---------------------------------------------------------------------------

function applyResize(
  start: AreaCell,
  handle: Handle,
  dxReal: number,
  dyReal: number,
): AreaCell {
  let { x, y, width, height } = start;
  switch (handle) {
    case 'nw': x += dxReal; y += dyReal; width -= dxReal; height -= dyReal; break;
    case 'n':  y += dyReal; height -= dyReal; break;
    case 'ne': y += dyReal; width += dxReal; height -= dyReal; break;
    case 'e':  width += dxReal; break;
    case 'se': width += dxReal; height += dyReal; break;
    case 's':  height += dyReal; break;
    case 'sw': x += dxReal; width -= dxReal; height += dyReal; break;
    case 'w':  x += dxReal; width -= dxReal; break;
  }
  if (width < MIN_SIZE) {
    if (handle === 'nw' || handle === 'w' || handle === 'sw') {
      x = start.x + start.width - MIN_SIZE;
    }
    width = MIN_SIZE;
  }
  if (height < MIN_SIZE) {
    if (handle === 'nw' || handle === 'n' || handle === 'ne') {
      y = start.y + start.height - MIN_SIZE;
    }
    height = MIN_SIZE;
  }
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// プレビューサイズ
// ---------------------------------------------------------------------------

function fitAspect(containerWidth: number, res: Resolution): Resolution {
  if (containerWidth <= 0 || res.width <= 0 || res.height <= 0) {
    return { width: 0, height: 0 };
  }
  return {
    width: containerWidth,
    height: containerWidth / (res.width / res.height),
  };
}

// ---------------------------------------------------------------------------
// エリアボックス（areas）
// ---------------------------------------------------------------------------

interface AreaBoxProps {
  area: MainArea | VisibleArea;
  refId: AreaRef;
  color: string;
  label: string;
  resolution: Resolution;
  preview: Resolution;
  selected: boolean;
  onPointerDownArea: (
    e: ReactPointerEvent<HTMLDivElement>,
    refId: AreaRef,
    mode: Mode,
  ) => void;
  onSelect: (refId: AreaRef) => void;
}

function AreaBox({
  area,
  refId,
  color,
  label,
  resolution,
  preview,
  selected,
  onPointerDownArea,
  onSelect,
}: AreaBoxProps) {
  const pv = useMemo(
    () => realToPreview(area, { real: resolution, preview }),
    [area, resolution, preview],
  );

  const showGrid = area.useGrid !== false;
  const gridLines = useMemo(() => {
    if (!showGrid || pv.width <= 0 || pv.height <= 0) return null;
    const lines: React.ReactElement[] = [];
    for (let c = 1; c < area.columns; c++) {
      const xx = (pv.width * c) / area.columns;
      lines.push(
        <div
          key={`v${c}`}
          className="absolute top-0 bottom-0 border-l border-dashed opacity-50"
          style={{ left: xx, borderColor: color }}
        />,
      );
    }
    for (let r = 1; r < area.rows; r++) {
      const yy = (pv.height * r) / area.rows;
      lines.push(
        <div
          key={`h${r}`}
          className="absolute left-0 right-0 border-t border-dashed opacity-50"
          style={{ top: yy, borderColor: color }}
        />,
      );
    }
    return lines;
  }, [showGrid, pv.width, pv.height, area.rows, area.columns, color]);

  return (
    <div
      className={cn(
        'absolute border-2',
        selected ? 'shadow-md' : 'opacity-90 hover:opacity-100',
      )}
      style={{
        left: pv.x,
        top: pv.y,
        width: pv.width,
        height: pv.height,
        borderColor: color,
        background: `${color}1a`,
        cursor: 'move',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onSelect(refId);
        onPointerDownArea(e, refId, { type: 'move' });
      }}
    >
      <div
        className="pointer-events-none absolute left-1 top-1 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium"
        style={{ color }}
      >
        {label}
      </div>
      {gridLines}
      {selected &&
        HANDLE_LIST.map((h) => (
          <div
            key={h}
            className={cn(
              'absolute h-2.5 w-2.5 rounded-sm bg-white border-2',
              handleClass[h],
            )}
            style={{ borderColor: color, touchAction: 'none' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onPointerDownArea(e, refId, { type: 'resize', handle: h });
            }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 画像レイヤボックス（fit='manual' + 選択中のみ表示）
// ---------------------------------------------------------------------------

interface LayerBoxProps {
  layer: ImageLayer;
  resolution: Resolution;
  preview: Resolution;
  onPointerDownLayer: (
    e: ReactPointerEvent<HTMLDivElement>,
    layerId: string,
    mode: Mode,
  ) => void;
}

function LayerBox({
  layer,
  resolution,
  preview,
  onPointerDownLayer,
}: LayerBoxProps) {
  if (layer.fit !== 'manual' || !layer.transform) return null;
  const pv = realToPreview(layer.transform, { real: resolution, preview });
  const color = '#9333ea';

  return (
    <div
      className="absolute border-2 border-dashed"
      style={{
        left: pv.x,
        top: pv.y,
        width: pv.width,
        height: pv.height,
        borderColor: color,
        background: `${color}10`,
        cursor: 'move',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        onPointerDownLayer(e, layer.id, { type: 'move' });
      }}
    >
      <div
        className="pointer-events-none absolute left-1 top-1 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium"
        style={{ color }}
      >
        image layer
      </div>
      {HANDLE_LIST.map((h) => (
        <div
          key={h}
          className={cn(
            'absolute h-2.5 w-2.5 rounded-sm bg-white border-2',
            handleClass[h],
          )}
          style={{ borderColor: color, touchAction: 'none' }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            onPointerDownLayer(e, layer.id, {
              type: 'resize',
              handle: h,
            });
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WallPreview 本体
// ---------------------------------------------------------------------------

export function WallPreview() {
  // 限定したスライスのみを購読する（不要な再描画を避ける）
  const background = useWallStore((s) => s.wall.background);
  const resolution = useWallStore((s) => s.wall.resolution);
  const layout = useWallStore((s) => s.wall.layout);
  const selectedLayerId = useWallStore(
    (s) => s.ui.selectedBackgroundLayerId,
  );
  const setMain = useWallStore((s) => s.setMain);
  const setLocked = useWallStore((s) => s.setLocked);
  const updatePreparing = useWallStore((s) => s.updatePreparing);
  const updateBackgroundLayer = useWallStore((s) => s.updateBackgroundLayer);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [preview, setPreview] = useState<Resolution>({ width: 0, height: 0 });
  const [selected, setSelected] = useState<AreaRef>({ kind: 'main' });

  /** ドラッグ中のオーバーレイ（px 表示・スナップ ヒット線）。null = 操作なし。 */
  const [dragOverlay, setDragOverlay] = useState<{
    cell: AreaCell;
    hitX: number | null;
    hitY: number | null;
  } | null>(null);

  // 選択中の画像レイヤ
  const selectedLayer = useMemo<ImageLayer | null>(() => {
    if (!selectedLayerId) return null;
    const l = background.layers.find((x) => x.id === selectedLayerId);
    if (!l || l.type !== 'image') return null;
    return l;
  }, [background.layers, selectedLayerId]);

  // ---- コンテナ幅 → preview サイズ ----
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setPreview(fitAspect(el.clientWidth, resolution));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resolution]);

  // ---- スナップ候補（他エリア＋キャンバス端） ----
  const buildSnapCandidates = useCallback(
    (movingRef: AreaRef): { xs: number[]; ys: number[] } => {
      const xs: number[] = [0, resolution.width / 2, resolution.width];
      const ys: number[] = [0, resolution.height / 2, resolution.height];
      const addCell = (c: AreaCell) => {
        xs.push(c.x, c.x + c.width / 2, c.x + c.width);
        ys.push(c.y, c.y + c.height / 2, c.y + c.height);
      };
      if (movingRef.kind !== 'main') addCell(layout.main);
      if (movingRef.kind !== 'locked' && layout.locked.show)
        addCell(layout.locked);
      layout.preparing.forEach((p, i) => {
        if (movingRef.kind === 'preparing' && movingRef.index === i) return;
        if (!p.show) return;
        addCell(p);
      });
      return { xs, ys };
    },
    [resolution, layout],
  );

  // ---- 開始セルの取得 ----
  const getStartCell = useCallback(
    (refId: AreaRef): AreaCell | null => {
      switch (refId.kind) {
        case 'main':
          return layout.main;
        case 'locked':
          return layout.locked;
        case 'preparing':
          return layout.preparing[refId.index] ?? null;
        case 'layer': {
          const l = background.layers.find((x) => x.id === refId.layerId);
          if (!l || l.type !== 'image') return null;
          if (l.fit !== 'manual') return null;
          return (
            l.transform ?? {
              x: 0,
              y: 0,
              width: resolution.width,
              height: resolution.height,
            }
          );
        }
      }
    },
    [layout, background.layers, resolution],
  );

  // ---- 反映 ----
  const dispatchCell = useCallback(
    (refId: AreaRef, cell: AreaCell) => {
      switch (refId.kind) {
        case 'main':
          setMain(cell);
          break;
        case 'locked':
          setLocked(cell);
          break;
        case 'preparing':
          updatePreparing(refId.index, cell);
          break;
        case 'layer':
          updateBackgroundLayer(refId.layerId, {
            type: 'image',
            transform: floorCell(cell),
          });
          break;
      }
    },
    [setMain, setLocked, updatePreparing, updateBackgroundLayer],
  );

  // ---- pointer handlers ----

  const onPointerDownArea = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      refId: AreaRef,
      mode: Mode,
    ) => {
      if (preview.width === 0 || preview.height === 0) return;
      const startCell = getStartCell(refId);
      if (!startCell) return;
      dragRef.current = {
        ref: refId,
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCell,
        pxToRealX: resolution.width / preview.width,
        pxToRealY: resolution.height / preview.height,
      };
      setDragOverlay({ cell: startCell, hitX: null, hitY: null });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [preview, resolution, getStartCell],
  );

  const onPointerDownLayer = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      layerId: string,
      mode: Mode,
    ) => {
      onPointerDownArea(e, { kind: 'layer', layerId }, mode);
    },
    [onPointerDownArea],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dxReal = (e.clientX - drag.startClientX) * drag.pxToRealX;
      const dyReal = (e.clientY - drag.startClientY) * drag.pxToRealY;
      let nextCell: AreaCell;
      if (drag.mode.type === 'move') {
        nextCell = {
          ...drag.startCell,
          x: drag.startCell.x + dxReal,
          y: drag.startCell.y + dyReal,
        };
      } else {
        nextCell = applyResize(drag.startCell, drag.mode.handle, dxReal, dyReal);
      }

      let hitX: number | null = null;
      let hitY: number | null = null;
      if (!e.shiftKey) {
        const cand = buildSnapCandidates(drag.ref);
        const thX = SNAP_PX_PREVIEW * drag.pxToRealX;
        const thY = SNAP_PX_PREVIEW * drag.pxToRealY;
        const result =
          drag.mode.type === 'move'
            ? snapMove(nextCell, cand, thX, thY)
            : snapResize(nextCell, drag.mode.handle, cand, thX, thY);
        nextCell = result.cell;
        hitX = result.hitX;
        hitY = result.hitY;
      }

      dispatchCell(drag.ref, nextCell);
      setDragOverlay({ cell: nextCell, hitX, hitY });
    },
    [buildSnapCandidates, dispatchCell],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragOverlay(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // ---- 描画用補助 ----

  const visiblePreparing = layout.preparing
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.show);

  // ドラッグオーバーレイ位置（プレビュー px）
  const overlayPv = useMemo(() => {
    if (!dragOverlay) return null;
    return realToPreview(dragOverlay.cell, {
      real: resolution,
      preview,
    });
  }, [dragOverlay, resolution, preview]);

  // スナップヒット線（プレビュー px）
  const hitLineX = useMemo(() => {
    if (!dragOverlay || dragOverlay.hitX === null) return null;
    return (dragOverlay.hitX / resolution.width) * preview.width;
  }, [dragOverlay, resolution.width, preview.width]);
  const hitLineY = useMemo(() => {
    if (!dragOverlay || dragOverlay.hitY === null) return null;
    return (dragOverlay.hitY / resolution.height) * preview.height;
  }, [dragOverlay, resolution.height, preview.height]);

  return (
    <div ref={containerRef} className="w-full">
      <div
        className="relative overflow-hidden rounded-md border border-border-strong bg-muted select-none"
        style={{ width: preview.width, height: preview.height }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setSelected({ kind: 'main' });
        }}
      >
        <BackgroundCanvas background={background} resolution={resolution} />

        {/* 画像レイヤ操作枠（fit=manual） */}
        {selectedLayer && (
          <LayerBox
            layer={selectedLayer}
            resolution={resolution}
            preview={preview}
            onPointerDownLayer={onPointerDownLayer}
          />
        )}

        <AreaBox
          area={layout.main}
          refId={{ kind: 'main' }}
          color="#2563eb"
          label="main"
          resolution={resolution}
          preview={preview}
          selected={selected.kind === 'main'}
          onPointerDownArea={onPointerDownArea}
          onSelect={setSelected}
        />
        {layout.locked.show && (
          <AreaBox
            area={layout.locked}
            refId={{ kind: 'locked' }}
            color="#ea580c"
            label="locked"
            resolution={resolution}
            preview={preview}
            selected={selected.kind === 'locked'}
            onPointerDownArea={onPointerDownArea}
            onSelect={setSelected}
          />
        )}
        {visiblePreparing.map(({ p, index }) => (
          <AreaBox
            key={index}
            area={p}
            refId={{ kind: 'preparing', index }}
            color="#16a34a"
            label={`preparing #${index + 1}`}
            resolution={resolution}
            preview={preview}
            selected={
              selected.kind === 'preparing' && selected.index === index
            }
            onPointerDownArea={onPointerDownArea}
            onSelect={setSelected}
          />
        ))}

        {/* スナップヒット線 */}
        {hitLineX !== null && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 border-l border-pink-500"
            style={{ left: hitLineX }}
          />
        )}
        {hitLineY !== null && (
          <div
            className="pointer-events-none absolute left-0 right-0 border-t border-pink-500"
            style={{ top: hitLineY }}
          />
        )}

        {/* ドラッグ中の px オーバーレイ */}
        {dragOverlay && overlayPv && (
          <div
            className="pointer-events-none absolute z-10 rounded bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-mono text-white shadow"
            style={{
              left: Math.max(0, Math.min(overlayPv.x, preview.width - 130)),
              top: Math.max(0, overlayPv.y - 22),
            }}
          >
            {Math.floor(dragOverlay.cell.x)}, {Math.floor(dragOverlay.cell.y)}{' '}
            / {Math.floor(dragOverlay.cell.width)}×
            {Math.floor(dragOverlay.cell.height)}
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-fg-subtle">
        実解像度 {resolution.width}×{resolution.height} / プレビュー{' '}
        {Math.round(preview.width)}×{Math.round(preview.height)} ·{' '}
        <span className="text-fg-subtle opacity-80">Shift でスナップ無効</span>
      </p>
    </div>
  );
}
