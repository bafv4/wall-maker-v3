/**
 * WallPreview — state.resolution のアスペクト比に追従するプレビュー。
 *
 *  - 背景は別コンポーネント `BackgroundCanvas` に分離。
 *    `background` / `resolution` の参照変化時のみ Canvas を再描画する（Phase 4d 最適化）。
 *    バッキングストアは**表示サイズ × devicePixelRatio**（実解像度で頭打ち）で確保し、
 *    再描画は `requestAnimationFrame` で 1 フレームに合体させる。実解像度で持つと
 *    カラーピッカーのドラッグ 1 イベントごとに MB 級の再確保とフル解像度の再合成が走る。
 *    エクスポートは `buildPack` が独立にフル解像度で描くのでプレビュー品質とは無関係。
 *  - エリア（main / locked / preparing[i]）はドラッグ移動・8 ハンドルでリサイズ。
 *    Ctrl/⌘+クリックで複数選択でき、選択中のエリアはドラッグでまとめて移動する
 *    （Shift はドラッグ中のスナップ無効に割当済みのため、トグルには使わない）。
 *    リサイズハンドルは単独選択のときだけ表示する（グループリサイズは非対応）。
 *  - 選択中の画像レイヤ（`fit:'manual'`）も同様に move/resize（レイヤは複数選択の対象外）。
 *  - スナップ: 他エリア辺・中央・キャンバス端と中央へ磁着（プレビュー基準 6px）。Shift で無効化。
 *    複数選択の移動では**選択全体の外接矩形**の辺・中央で判定する（指示線も同じ基準）。
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
import { useTranslation } from 'react-i18next';
import {
  MAX_DIMENSION,
  MIN_COORDINATE,
  boundingBox,
  floorCell,
  realToPreview,
} from '../core/coords';
import { renderBackgroundToCanvas } from '../core/renderBackground';
import type {
  AreaCell,
  ImageLayer,
  MainArea,
  Resolution,
  VisibleArea,
  WallState,
} from '../core/state';
import {
  DEFAULT_AREA_SELECTION,
  useWallStore,
  type AreaMove,
  type AreaTarget,
} from '../store/useWallStore';
import { snapMove, snapResize, type Handle } from './snap';
import { cn } from './ui/cn';

// ---------------------------------------------------------------------------
// 操作対象の識別子
// ---------------------------------------------------------------------------

type AreaRef =
  | AreaTarget
  | { kind: 'layer'; layerId: string };

type Mode = { type: 'move' } | { type: 'resize'; handle: Handle };

/** 選択集合の membership 判定・スナップ候補の除外に使う安定キー。 */
function areaRefKey(ref: AreaRef): string {
  switch (ref.kind) {
    case 'main':
      return 'main';
    case 'locked':
      return 'locked';
    case 'preparing':
      return `preparing:${ref.index}`;
    case 'layer':
      return `layer:${ref.layerId}`;
  }
}

// 描画・選択判定で使い回す固定参照（毎レンダーの再生成とキー書式の手書きを避ける）
const MAIN_REF: AreaRef = { kind: 'main' };
const LOCKED_REF: AreaRef = { kind: 'locked' };
const MAIN_KEY = areaRefKey(MAIN_REF);
const LOCKED_KEY = areaRefKey(LOCKED_REF);

/** 選択集合から layer を除いて AreaTarget[] に絞る（選択にはエリアしか入らない）。 */
function areaTargets(refs: readonly AreaRef[]): AreaTarget[] {
  return refs.filter((r): r is AreaTarget => r.kind !== 'layer');
}

/**
 * 複数選択ドラッグの開始閾値（CSS px）。この距離を超えるまでは store に反映しない。
 * 超えずに離した場合は「クリック」とみなし、押したメンバーの単独選択へ縮退する
 * （選択済みメンバーの上でも通常クリックで単独選択に戻れるようにするため）。
 */
const GROUP_DRAG_START_THRESHOLD_CSS = 3;

interface DragItem {
  ref: AreaRef;
  startCell: AreaCell;
}

interface DragState {
  mode: Mode;
  /** move: 選択中の全エリア（1..N）。resize / layer: 必ず 1 件。 */
  items: DragItem[];
  /**
   * pointerdown されたエリア。move かつ複数選択で、閾値を超えずに離された
   * 「クリック」のとき、このエリアの単独選択へ縮退させる。
   */
  pressedRef: AreaRef | null;
  /** 複数選択の move が開始閾値を一度でも超えたか。 */
  moved: boolean;
  /**
   * ドラッグ中は不変な派生値。開始時と startCellRefreshed の読み直し後に
   * initDragDerived で再計算する（pointermove ごとの再確保を避ける）。
   *  - bbox0: 開始時セル群の外接矩形（move のスナップ・移動量の基準）
   *  - maxStartX/Y: メンバー x/y の最大値。クランプ境界（±MAX_DIMENSION）でも
   *    グループの剛体性が壊れないよう、移動量の上限を導くのに使う
   *  - cand: スナップ候補（移動中メンバーを除外済み。他エリアはドラッグ中に変化しない）
   */
  bbox0: AreaCell;
  maxStartX: number;
  maxStartY: number;
  cand: { xs: number[]; ys: number[] };
  startClientX: number;
  startClientY: number;
  /**
   * items の startCell を最初の pointermove で store から読み直したか。
   * 数値入力欄の blur コミットは pointerdown の後・最初の pointermove の前に発火するため、
   * pointerdown 時に捕捉した startCell はコミット直前の旧値であり得る。
   * そのまま全フィールドを dispatch すると、blur でコミットした値を旧値で巻き戻してしまう。
   */
  startCellRefreshed: boolean;
  pxToRealX: number;
  pxToRealY: number;
  /**
   * 直前に dispatch した整数セル（move では選択全体の外接矩形）とスナップヒット。
   * store の `mergeAreaPatch` は常に新しい area/layout オブジェクトを作るため、
   * 整数化した結果が前回と同じでも再レンダリング＋永続化まで走ってしまう。
   * 主に効くのは、スナップ線に磁着している間（閾値内のポインタ移動はすべて
   * 同じセルに丸められる）と、1 CSS px 未満しか動かない高レートのポインタ入力。
   */
  lastCell: AreaCell | null;
  lastHitX: number | null;
  lastHitY: number | null;
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

/**
 * バッキングストア確保時の DPR 上限。HiDPI で無駄に巨大な canvas を作らないための頭打ち。
 */
const MAX_PREVIEW_DPR = 2;

/**
 * `devicePixelRatio` を購読する。DPI の違うモニタへウィンドウを移動したり
 * OS の表示スケールを変えても CSS px サイズは変わらず ResizeObserver も鳴らないため、
 * これが無いとバッキングストアが古い DPR のまま取り残されてプレビューがボヤける。
 *
 * 現在値ちょうどにマッチするメディアクエリを張り、外れた瞬間に読み直す定石。
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

interface BackgroundCanvasProps {
  background: WallState['background'];
  resolution: Resolution;
  /** CSS 表示サイズ（プレビュー px）。バッキングストアはこれ × DPR で確保する。 */
  preview: Resolution;
}

const BackgroundCanvas = memo(function BackgroundCanvas({
  background,
  resolution,
  preview,
}: BackgroundCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rawDpr = useDevicePixelRatio();
  const dpr = Math.min(rawDpr, MAX_PREVIEW_DPR);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (preview.width <= 0 || preview.height <= 0) return;
    if (resolution.width <= 0 || resolution.height <= 0) return;

    let cancelled = false;
    // カラーピッカーのドラッグ・スライダー・数値入力の 1 ストロークごとに
    // `background` の参照が変わりこの effect が再実行される。rAF で 1 フレームに
    // 合体させ、追い越されたフレームは cleanup で捨てる。
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      // 実解像度を超えて確保しても情報量は増えないので上限にする。
      const w = Math.max(
        1,
        Math.min(Math.round(preview.width * dpr), resolution.width),
      );
      const h = Math.max(
        1,
        Math.min(Math.round(preview.height * dpr), resolution.height),
      );
      // canvas.width/height への代入は、同じ値でもバッキングストアの再確保＋
      // ゼロ埋めを伴う（HTML 仕様）。サイズが変わったときだけ代入する。
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      void renderBackgroundToCanvas(
        canvas,
        background,
        resolution,
        () => cancelled,
      ).catch((e) => {
        if (!cancelled) console.error('background render failed', e);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // preview は毎回新しいオブジェクトになり得るので実数値で依存を取る。
  }, [background, resolution, preview.width, preview.height, dpr]);

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

/** 整数化済みセル同士の同値判定（ドラッグ中の無駄な store 更新を抑えるため）。 */
function sameCell(a: AreaCell | null, b: AreaCell): boolean {
  return (
    a !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * resize / move 共通の dedupe。前回 dispatch した結果と比較し、変化があれば
 * 記録して true を返す。false のときは store 更新もオーバーレイ更新も不要
 * （store 側は floorArea するので、floor 後が同じなら state は 1bit も変わらない）。
 */
function rememberDragResult(
  drag: DragState,
  cell: AreaCell,
  hitX: number | null,
  hitY: number | null,
): boolean {
  if (
    sameCell(drag.lastCell, cell) &&
    drag.lastHitX === hitX &&
    drag.lastHitY === hitY
  ) {
    return false;
  }
  drag.lastCell = cell;
  drag.lastHitX = hitX;
  drag.lastHitY = hitY;
  return true;
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
  /** 選択がこの 1 件だけか。リサイズハンドルは selected && soleSelection のときだけ出す。 */
  soleSelection: boolean;
  onPointerDownArea: (
    e: ReactPointerEvent<HTMLDivElement>,
    refId: AreaRef,
    mode: Mode,
  ) => void;
}

function AreaBox({
  area,
  refId,
  color,
  label,
  resolution,
  preview,
  selected,
  soleSelection,
  onPointerDownArea,
}: AreaBoxProps) {
  // グループリサイズは非対応なので、ハンドルは単独選択のときだけ表示する
  const showHandles = selected && soleSelection;
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
        // 選択の更新（トグル/単独化）とドラッグ開始は親がまとめて判断する
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
      {showHandles &&
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
  const { t } = useTranslation();

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
  const moveAreas = useWallStore((s) => s.moveAreas);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [preview, setPreview] = useState<Resolution>({ width: 0, height: 0 });

  // 選択集合（1 件以上）。Ctrl/⌘+クリックでトグル、通常クリックで単独選択。
  // 実体は store（ui.selectedAreas）。preparing 削除時の index 詰め直しは
  // removePreparing が削除と同じ set() 内で行う（store 参照）。
  const rawSelected = useWallStore((s) => s.ui.selectedAreas);
  const selectAreas = useWallStore((s) => s.selectAreas);
  // 非表示のエリアを選択から除く。空になったら main に戻す
  // （既存挙動: 空クリックでも main が選択される＝常に何かが選択されている）。
  // ドラッグ中は layout.preparing の identity が毎フレーム変わるため、
  // 何も落ちなかったときは入力の identity をそのまま返して下流の memo を守る。
  const selectedRefs = useMemo<readonly AreaRef[]>(() => {
    const alive = rawSelected.filter((r) => {
      if (r.kind === 'main') return true;
      if (r.kind === 'locked') return layout.locked.show;
      return layout.preparing[r.index]?.show === true;
    });
    if (alive.length === rawSelected.length) return rawSelected;
    return alive.length > 0 ? alive : DEFAULT_AREA_SELECTION;
  }, [rawSelected, layout.locked.show, layout.preparing]);
  const selectedKeys = useMemo(
    () => new Set(selectedRefs.map(areaRefKey)),
    [selectedRefs],
  );

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
  // 移動中のエリア（複数選択なら選択中の全エリア）を候補から除く。
  const buildSnapCandidates = useCallback(
    (excludeKeys: ReadonlySet<string>): { xs: number[]; ys: number[] } => {
      const xs: number[] = [0, resolution.width / 2, resolution.width];
      const ys: number[] = [0, resolution.height / 2, resolution.height];
      const addCell = (c: AreaCell) => {
        xs.push(c.x, c.x + c.width / 2, c.x + c.width);
        ys.push(c.y, c.y + c.height / 2, c.y + c.height);
      };
      if (!excludeKeys.has(MAIN_KEY)) addCell(layout.main);
      if (!excludeKeys.has(LOCKED_KEY) && layout.locked.show)
        addCell(layout.locked);
      layout.preparing.forEach((p, i) => {
        if (excludeKeys.has(areaRefKey({ kind: 'preparing', index: i })))
          return;
        if (!p.show) return;
        addCell(p);
      });
      return { xs, ys };
    },
    [resolution, layout],
  );

  // ---- 開始セルの取得 ----
  // 購読 state のクロージャではなく store を直接読む。イベントハンドラ内では
  // React の再レンダーを待たず常に最新の state を基準にするため。
  const getStartCell = useCallback((refId: AreaRef): AreaCell | null => {
    const wall = useWallStore.getState().wall;
    switch (refId.kind) {
      case 'main':
        return wall.layout.main;
      case 'locked':
        return wall.layout.locked;
      case 'preparing':
        return wall.layout.preparing[refId.index] ?? null;
      case 'layer': {
        const l = wall.background.layers.find((x) => x.id === refId.layerId);
        if (!l || l.type !== 'image') return null;
        if (l.fit !== 'manual') return null;
        return (
          l.transform ?? {
            x: 0,
            y: 0,
            width: wall.resolution.width,
            height: wall.resolution.height,
          }
        );
      }
    }
  }, []);

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

  /**
   * items からドラッグ中不変の派生値（外接矩形・メンバー最大座標・スナップ候補）を
   * 再計算して drag に書き込む。開始時と startCellRefreshed の読み直し後に呼ぶ。
   */
  const initDragDerived = useCallback(
    (
      items: DragItem[],
    ): Pick<DragState, 'bbox0' | 'maxStartX' | 'maxStartY' | 'cand'> => {
      const cells = items.map((i) => i.startCell);
      const bbox0 = boundingBox(cells);
      let maxStartX = -Infinity;
      let maxStartY = -Infinity;
      for (const c of cells) {
        maxStartX = Math.max(maxStartX, c.x);
        maxStartY = Math.max(maxStartY, c.y);
      }
      return {
        bbox0,
        maxStartX,
        maxStartY,
        cand: buildSnapCandidates(new Set(items.map((i) => areaRefKey(i.ref)))),
      };
    },
    [buildSnapCandidates],
  );

  /** ドラッグを開始する。move では items が選択中の全エリア、それ以外は 1 件。 */
  const startDrag = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      refs: readonly AreaRef[],
      mode: Mode,
      pressedRef: AreaRef | null = null,
    ) => {
      if (preview.width === 0 || preview.height === 0) return;
      const items: DragItem[] = [];
      for (const ref of refs) {
        const startCell = getStartCell(ref);
        if (startCell) items.push({ ref, startCell });
      }
      if (items.length === 0) return;
      dragRef.current = {
        mode,
        items,
        pressedRef,
        moved: false,
        ...initDragDerived(items),
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCellRefreshed: false,
        pxToRealX: resolution.width / preview.width,
        pxToRealY: resolution.height / preview.height,
        lastCell: null,
        lastHitX: null,
        lastHitY: null,
      };
      setDragOverlay({
        cell: dragRef.current.bbox0,
        hitX: null,
        hitY: null,
      });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [preview, resolution, getStartCell, initDragDerived],
  );

  const onPointerDownArea = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      refId: AreaRef,
      mode: Mode,
    ) => {
      if (mode.type === 'resize') {
        // ハンドルは単独選択のときしか表示されないが、防御的に単独化しておく
        if (refId.kind !== 'layer') selectAreas([refId]);
        startDrag(e, [refId], mode);
        return;
      }
      const key = areaRefKey(refId);
      if (e.ctrlKey || e.metaKey) {
        // トグルのみ（このジェスチャではドラッグを開始しない）。
        // Shift は「ドラッグ中のスナップ無効」に割当済みなのでトグルには使わない。
        // Shift+pointerdown をトグルにすると、ヒントに書かれた
        // 「Shift を押しながらドラッグ＝スナップなし移動」が開始できなくなる。
        if (refId.kind !== 'layer') {
          selectAreas(
            selectedKeys.has(key)
              ? areaTargets(selectedRefs).filter(
                  (r) => areaRefKey(r) !== key,
                )
              : [...areaTargets(selectedRefs), refId],
          );
        }
        return;
      }
      if (selectedKeys.has(key)) {
        // 選択済みメンバーの通常ドラッグ → 選択全体をまとめて移動。
        // 閾値を超えず離された「クリック」なら pressedRef の単独選択へ縮退する。
        startDrag(e, selectedRefs, mode, refId);
      } else {
        if (refId.kind !== 'layer') selectAreas([refId]);
        startDrag(e, [refId], mode);
      }
    },
    [selectedKeys, selectedRefs, selectAreas, startDrag],
  );

  const onPointerDownLayer = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      layerId: string,
      mode: Mode,
    ) => {
      // レイヤは複数選択の対象外（常に単独ドラッグ）
      startDrag(e, [{ kind: 'layer', layerId }], mode);
    },
    [startDrag],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.startCellRefreshed) {
        // DragState.startCellRefreshed のコメント参照（blur コミット後の値で基準を取り直す）。
        // blur コミットはどのエリアの値も変えうるので、派生値（bbox0/候補）も作り直す。
        drag.startCellRefreshed = true;
        drag.items = drag.items.flatMap((item) => {
          const fresh = getStartCell(item.ref);
          return fresh ? [{ ref: item.ref, startCell: fresh }] : [];
        });
        if (drag.items.length === 0) {
          dragRef.current = null;
          setDragOverlay(null);
          return;
        }
        Object.assign(drag, initDragDerived(drag.items));
      }
      const dxCss = e.clientX - drag.startClientX;
      const dyCss = e.clientY - drag.startClientY;
      const dxReal = dxCss * drag.pxToRealX;
      const dyReal = dyCss * drag.pxToRealY;
      const thX = SNAP_PX_PREVIEW * drag.pxToRealX;
      const thY = SNAP_PX_PREVIEW * drag.pxToRealY;

      if (drag.mode.type === 'resize') {
        // リサイズは常に単独（ハンドルは単独選択時のみ表示）
        const item = drag.items[0];
        let nextCell = applyResize(
          item.startCell,
          drag.mode.handle,
          dxReal,
          dyReal,
        );
        let hitX: number | null = null;
        let hitY: number | null = null;
        if (!e.shiftKey) {
          const result = snapResize(
            nextCell,
            drag.mode.handle,
            drag.cand,
            thX,
            thY,
          );
          nextCell = result.cell;
          hitX = result.hitX;
          hitY = result.hitY;
        }
        const nextFloored = floorCell(nextCell);
        if (!rememberDragResult(drag, nextFloored, hitX, hitY)) return;
        dispatchCell(item.ref, nextFloored);
        setDragOverlay({ cell: nextFloored, hitX, hitY });
        return;
      }

      // ---- move（1..N 件） ----
      // スナップ・指示線・オーバーレイは選択全体の外接矩形（bbox0）で判定する。
      // 開始セルは整数（store が floor 済み）なので bbox0 も整数。移動量を
      // 「floor した外接矩形の変位」として整数化してから各エリアへ同量だけ足すことで、
      // グループ内の相対位置が 1px も崩れない剛体移動になる。
      // 複数選択では閾値を超えるまで store に反映しない。超えずに離されたら
      // 「クリック」として onPointerUp が pressedRef の単独選択へ縮退させる。
      if (
        drag.items.length > 1 &&
        !drag.moved &&
        Math.abs(dxCss) < GROUP_DRAG_START_THRESHOLD_CSS &&
        Math.abs(dyCss) < GROUP_DRAG_START_THRESHOLD_CSS
      ) {
        return;
      }
      drag.moved = true;

      const bbox0 = drag.bbox0;
      let movedBox: AreaCell = {
        ...bbox0,
        x: bbox0.x + dxReal,
        y: bbox0.y + dyReal,
      };
      let hitX: number | null = null;
      let hitY: number | null = null;
      if (!e.shiftKey) {
        const result = snapMove(movedBox, drag.cand, thX, thY);
        movedBox = result.cell;
        hitX = result.hitX;
        hitY = result.hitY;
      }

      // 移動量の整数化。さらに全メンバーが座標クランプ（±MAX_DIMENSION）の内側に
      // 収まるよう移動量自体を制限する。制限せずに store 側で各メンバーが独立に
      // クランプされると、境界に触れたメンバーだけ止まりグループが変形してしまう。
      const flooredBox = floorCell(movedBox);
      const rawDx = flooredBox.x - bbox0.x;
      const rawDy = flooredBox.y - bbox0.y;
      const intDx = Math.max(
        MIN_COORDINATE - bbox0.x,
        Math.min(rawDx, MAX_DIMENSION - drag.maxStartX),
      );
      const intDy = Math.max(
        MIN_COORDINATE - bbox0.y,
        Math.min(rawDy, MAX_DIMENSION - drag.maxStartY),
      );
      // クランプで移動量が変わった軸は、スナップ位置に居ないので指示線を消す
      if (intDx !== rawDx) hitX = null;
      if (intDy !== rawDy) hitY = null;

      // オーバーレイと dedupe は bbox0 の寸法をそのまま使う（floorCell の width
      // クランプ（上限 MAX_DIMENSION）で、広い選択の寸法表示が誤らないように）。
      const finalBox: AreaCell = {
        x: bbox0.x + intDx,
        y: bbox0.y + intDy,
        width: bbox0.width,
        height: bbox0.height,
      };
      if (!rememberDragResult(drag, finalBox, hitX, hitY)) return;

      // layer は選択に入らないので単独ドラッグでしか来ない。それ以外は
      // 件数に関わらず moveAreas（1 回の set()）でまとめて反映する。
      const soloLayer =
        drag.items.length === 1 && drag.items[0].ref.kind === 'layer'
          ? drag.items[0]
          : null;
      if (soloLayer) {
        dispatchCell(soloLayer.ref, {
          ...soloLayer.startCell,
          x: soloLayer.startCell.x + intDx,
          y: soloLayer.startCell.y + intDy,
        });
      } else {
        moveAreas(
          drag.items.flatMap((item): AreaMove[] =>
            item.ref.kind === 'layer'
              ? []
              : [
                  {
                    ...item.ref,
                    x: item.startCell.x + intDx,
                    y: item.startCell.y + intDy,
                  },
                ],
          ),
        );
      }
      setDragOverlay({ cell: finalBox, hitX, hitY });
    },
    [dispatchCell, moveAreas, getStartCell, initDragDerived],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 複数選択のメンバーを「クリック」（閾値未満で離した）→ そのエリアの単独選択へ。
    // 旧実装の「pointerdown したエリアが必ず単独選択になる」を、グループ移動と
    // 両立する形（move が始まらなかったときだけ）で復元する。
    // pressedRef は複数選択の move でしか渡されないので、mode/件数の再検査は不要
    if (drag.pressedRef && !drag.moved && drag.pressedRef.kind !== 'layer') {
      selectAreas([drag.pressedRef]);
    }
    dragRef.current = null;
    setDragOverlay(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, [selectAreas]);

  // ---- 描画用補助 ----

  const visiblePreparing = layout.preparing
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.show);

  const soleSelection = selectedRefs.length === 1;

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
          // 空クリックで main の単独選択に戻す（Ctrl/⌘ 中はトグル操作の
          // 空振りとして選択を維持する。Shift はスナップ無効用なので対象外）
          if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey) {
            selectAreas(DEFAULT_AREA_SELECTION);
          }
        }}
      >
        <BackgroundCanvas
          background={background}
          resolution={resolution}
          preview={preview}
        />

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
          refId={MAIN_REF}
          color="#2563eb"
          label="main"
          resolution={resolution}
          preview={preview}
          selected={selectedKeys.has(MAIN_KEY)}
          soleSelection={soleSelection}
          onPointerDownArea={onPointerDownArea}
        />
        {layout.locked.show && (
          <AreaBox
            area={layout.locked}
            refId={LOCKED_REF}
            color="#ea580c"
            label="locked"
            resolution={resolution}
            preview={preview}
            selected={selectedKeys.has(LOCKED_KEY)}
            soleSelection={soleSelection}
            onPointerDownArea={onPointerDownArea}
          />
        )}
        {visiblePreparing.map(({ p, index }) => {
          const ref: AreaRef = { kind: 'preparing', index };
          return (
            <AreaBox
              key={index}
              area={p}
              refId={ref}
              color="#16a34a"
              label={`preparing #${index + 1}`}
              resolution={resolution}
              preview={preview}
              selected={selectedKeys.has(areaRefKey(ref))}
              soleSelection={soleSelection}
              onPointerDownArea={onPointerDownArea}
            />
          );
        })}

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
        {t('preview.scale', {
          realWidth: resolution.width,
          realHeight: resolution.height,
          previewWidth: Math.round(preview.width),
          previewHeight: Math.round(preview.height),
        })}{' '}
        ·{' '}
        <span className="text-fg-subtle opacity-80">
          {t('preview.snapHint')}
        </span>
      </p>
    </div>
  );
}
