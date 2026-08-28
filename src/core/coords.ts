/**
 * coords — 座標変換とスケールを 1 モジュールに集約する。
 * 仕様: REWRITE_SPEC.md 第4.5章。
 *
 * 旧実装は座標変換が `setResolution`・プレビューのドラッグ処理・import の percentage 変換などに散在し、
 * ズレや小数の混入を招いていた。新実装では本モジュールに以下を集中させる:
 *
 *  - プレビュー px ↔ 実解像度 px の相互変換（プレビュー・エクスポート・インポートで同一関数を使う）。
 *  - 解像度変更時のエリア＋背景レイヤ座標の一括スケール。
 *  - **境界での Math.floor 整数化**：エクスポートおよび state 反映時に、x/y/width/height を切り捨てる。
 *    旧実装は切り上げも切り捨てもせず JSON に小数が混入し、SeedQueue が framebuffer 比率と
 *    誤解釈してレイアウト破壊する実バグだった（第6.3.1章）。
 *    ドラッグ入力側でも floor を適用し、state に小数を持ち込まない。
 */

import { DEFAULT_RESOLUTION } from './state';
import type {
  Area,
  AreaCell,
  BackgroundLayer,
  Resolution,
  WallState,
} from './state';

// ---------------------------------------------------------------------------
// 数値ガード（非有限値・過大値を state に入れない）
//
// 旧実装は数値境界を一律 `Math.max(1, Math.floor(Number(x) || 0))` で書いていたが、
// これは **Infinity をそのまま通し、`Math.max(1, NaN)` は 1 ではなく NaN を返す**。
// `<input type="number">` は指数表記を正当な入力として返すため "1e999" → Infinity が実際に入る。
// 非有限値が layout に入ると:
//  - `JSON.stringify` が Infinity/NaN を **null** に潰すので、リロード後の state は
//    `x: null` のまま残り、floor ガードでも復元できない（永続化 state の恒久破壊）。
//  - `buildPack` が `custom_layout.json` に `"x": null` を出す（実機で黙って壊れる）。
//  - `new OffscreenCanvas(Infinity, Infinity)` が throw して export 自体が失敗する。
// 数値が state / 出力に入る境界は必ず `toSafeInt` を通すこと。
// ---------------------------------------------------------------------------

/** 幅・高さ・座標の上限 px。Canvas の実用上限に合わせる（有限でも 1e9 は OOM する）。 */
export const MAX_DIMENSION = 16384;

/** 座標の下限 px。x/y は画面外配置のため負を許容する（width/height は許容しない）。 */
export const MIN_COORDINATE = -MAX_DIMENSION;

/** rows/columns の上限。1 以上の整数という不変条件（CLAUDE.md）に実用上限を足したもの。 */
export const MAX_GRID_COUNT = 1024;

/**
 * 任意の入力を「有限の整数」に落とし込む共通ガード。
 *  - 非有限（NaN / ±Infinity）・null / undefined / 空文字 は `fallback` に倒す。
 *  - `Math.floor` してから `[min, max]` にクランプする。
 *  - `fallback` 自体が壊れていた場合は `min` を返す（返り値は必ず有限の整数）。
 */
export function toSafeInt(
  value: unknown,
  fallback: number,
  min = 0,
  max = MAX_DIMENSION,
): number {
  // null / undefined / 空文字は Number() が 0 や NaN に化けるので明示的に fallback へ倒す。
  const raw =
    value === null || value === undefined || value === '' ? NaN : Number(value);
  const base = Number.isFinite(raw) ? raw : Number(fallback);
  if (!Number.isFinite(base)) return min;
  return Math.min(max, Math.max(min, Math.floor(base)));
}

/**
 * 解像度を 1..MAX_DIMENSION の整数に正規化する。
 * 0 以下・非有限は「不明」とみなして `fallback` を採用する（0 を 1 にクランプすると
 * `to.width / from.width` が桁違いに跳ね上がり、layout が別の壊れ方をするため）。
 */
export function safeResolution(
  resolution: Resolution | undefined,
  fallback: Resolution = DEFAULT_RESOLUTION,
): Resolution {
  const w = toSafeInt(resolution?.width, 0, 0);
  const h = toSafeInt(resolution?.height, 0, 0);
  return {
    width: w >= 1 ? w : toSafeInt(fallback.width, DEFAULT_RESOLUTION.width, 1),
    height:
      h >= 1 ? h : toSafeInt(fallback.height, DEFAULT_RESOLUTION.height, 1),
  };
}

// ---------------------------------------------------------------------------
// 整数化（境界での floor）
// floorCell / floorArea が幾何の不変条件（整数・非有限禁止・負サイズ禁止・rows/columns >= 1）を
// **一箇所で** 担保する。layout に触る経路は必ずどちらかを通す。
// ---------------------------------------------------------------------------

export function floorInt(n: number): number {
  return toSafeInt(n, 0, MIN_COORDINATE, MAX_DIMENSION);
}

/**
 * セル群の外接矩形。プレビューの複数選択ドラッグでは、スナップ・指示線・
 * オーバーレイ表示を個々のエリアではなく**選択全体**のこの矩形に対して行う。
 * 呼び出し側が 1 件以上を保証する。入力が整数（store は floorArea/floorCell 済み）
 * なら結果も整数。クランプは行わない（移動量の導出に使うため、値を歪めない）。
 */
export function boundingBox(cells: readonly AreaCell[]): AreaCell {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function floorCell<T extends AreaCell>(cell: T): T {
  return {
    ...cell,
    x: toSafeInt(cell.x, 0, MIN_COORDINATE),
    y: toSafeInt(cell.y, 0, MIN_COORDINATE),
    // 0/負サイズ禁止（CLAUDE.md 不変条件）。スケール縮小で 0 に潰れるのもここで防ぐ。
    width: toSafeInt(cell.width, 1, 1),
    height: toSafeInt(cell.height, 1, 1),
  };
}

export function floorArea<T extends Area>(area: T): T {
  const floored: T = {
    ...area,
    x: toSafeInt(area.x, 0, MIN_COORDINATE),
    y: toSafeInt(area.y, 0, MIN_COORDINATE),
    width: toSafeInt(area.width, 1, 1),
    height: toSafeInt(area.height, 1, 1),
    rows: toSafeInt(area.rows, 1, 1, MAX_GRID_COUNT),
    columns: toSafeInt(area.columns, 1, 1, MAX_GRID_COUNT),
  };
  if (area.positions) {
    floored.positions = area.positions.map((p) => floorCell(p));
  }
  if (area.padding !== undefined) {
    floored.padding = toSafeInt(area.padding, 0, 0);
  }
  return floored;
}

// ---------------------------------------------------------------------------
// プレビュー ↔ 実解像度 の相互変換
// 同一アスペクト比とは限らない（プレビュー側にフレームが入り得る）。
// X/Y 独立スケール: sx = preview.width/real.width, sy = preview.height/real.height。
// 描画/UI 用は丸めない。state 反映時は floorCell を併用する。
// ---------------------------------------------------------------------------

export interface PreviewViewport {
  real: Resolution;
  preview: Resolution;
}

export function realToPreview(
  cell: AreaCell,
  viewport: PreviewViewport,
): AreaCell {
  const sx = viewport.preview.width / viewport.real.width;
  const sy = viewport.preview.height / viewport.real.height;
  return {
    x: cell.x * sx,
    y: cell.y * sy,
    width: cell.width * sx,
    height: cell.height * sy,
  };
}

export function previewToReal(
  cell: AreaCell,
  viewport: PreviewViewport,
): AreaCell {
  const sx = viewport.real.width / viewport.preview.width;
  const sy = viewport.real.height / viewport.preview.height;
  return {
    x: cell.x * sx,
    y: cell.y * sy,
    width: cell.width * sx,
    height: cell.height * sy,
  };
}

// ---------------------------------------------------------------------------
// 解像度変更時の一括スケール
// 旧実装はエリアのみスケールし背景レイヤがズレていた（第8章 #9）。
// 新実装はエリア＋背景レイヤ（image レイヤの transform）の両方をスケールし floor する。
// crop は元画像の自然 px 空間のソース矩形なので解像度変更では触らない。
// ---------------------------------------------------------------------------

export function scaleArea<T extends Area>(
  area: T,
  scaleX: number,
  scaleY: number,
): T {
  const scaled: T = {
    ...area,
    x: area.x * scaleX,
    y: area.y * scaleY,
    width: area.width * scaleX,
    height: area.height * scaleY,
  };
  if (area.positions) {
    scaled.positions = area.positions.map((p) => ({
      x: p.x * scaleX,
      y: p.y * scaleY,
      width: p.width * scaleX,
      height: p.height * scaleY,
    }));
  }
  if (area.padding !== undefined) {
    // X/Y 非等倍時は保守的に小さい方の倍率を採用（間隔が広がり過ぎてはみ出すのを防ぐ）
    scaled.padding = area.padding * Math.min(scaleX, scaleY);
  }
  // floorArea が最小サイズ 1・非有限禁止を担保する。
  // （縮小で width が 0 に潰れると state に 0 が焼き付き、拡大しても戻らなくなる）
  return floorArea(scaled);
}

export function scaleBackgroundLayer(
  layer: BackgroundLayer,
  scaleX: number,
  scaleY: number,
): BackgroundLayer {
  if (layer.type === 'image' && layer.transform) {
    return {
      ...layer,
      // floorCell 経由でエリアと同じ不変条件（整数・非有限禁止・最小サイズ 1）を適用する。
      transform: floorCell({
        x: layer.transform.x * scaleX,
        y: layer.transform.y * scaleY,
        width: layer.transform.width * scaleX,
        height: layer.transform.height * scaleY,
      }),
    };
  }
  return layer;
}

export function scaleStateForResolution(
  state: WallState,
  from: Resolution,
  to: Resolution,
): WallState {
  // 解像度が 0 / NaN / Infinity だと sx・sy が非有限になり layout 全体を汚染するため、
  // 倍率を出す前に必ず 1..MAX_DIMENSION の整数へ丸める。
  const fromRes = safeResolution(from);
  const toRes = safeResolution(to, fromRes);
  const sx = toRes.width / fromRes.width;
  const sy = toRes.height / fromRes.height;
  return {
    ...state,
    resolution: toRes,
    layout: {
      main: scaleArea(state.layout.main, sx, sy),
      locked: scaleArea(state.layout.locked, sx, sy),
      preparing: state.layout.preparing.map((p) => scaleArea(p, sx, sy)),
    },
    background: {
      layers: state.background.layers.map((l) =>
        scaleBackgroundLayer(l, sx, sy),
      ),
    },
  };
}

/**
 * WallState の数値を不変条件へ引き戻す（幾何のみ・他のフィールドは触らない）。
 *
 * 旧バージョンで Infinity が混入した state は `JSON.stringify` により `x: null` として
 * 永続化されており、通常操作では復旧できない。hydrate と state 丸ごと差し替えの境界で
 * 本関数を通し、壊れた値をその場で修復する。
 */
export function normalizeWallStateNumbers(state: WallState): WallState {
  return {
    ...state,
    resolution: safeResolution(state.resolution),
    layout: {
      main: floorArea(state.layout.main),
      locked: floorArea(state.layout.locked),
      preparing: state.layout.preparing.map((p) => floorArea(p)),
    },
    background: {
      layers: state.background.layers.map((l) =>
        l.type === 'image' && l.transform
          ? { ...l, transform: floorCell(l.transform) }
          : l,
      ),
    },
  };
}
