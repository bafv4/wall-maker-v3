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

import type {
  Area,
  AreaCell,
  BackgroundLayer,
  Resolution,
  WallState,
} from './state';

// ---------------------------------------------------------------------------
// 整数化（境界での floor）
// ---------------------------------------------------------------------------

export function floorInt(n: number): number {
  return Math.floor(n);
}

/**
 * rows / columns の上限。SeedQueue の実用ウォールはせいぜい数十セルなので十分に広い。
 *
 * 上限が必要な理由: `rows`/`columns` は外部パックの `custom_layout.json` 由来で
 * 完全に信用できない。下限 1 のクランプしか無いと `rows: 1e9` のような値がそのまま
 * state に入り、プレビューがグリッド線 1 本＝1 要素を作るループで固まる（描画 DoS）。
 * 信頼境界（parsePack / store アクション）で必ず本関数を通すこと。
 */
export const MAX_GRID_COUNT = 256;

/** rows / columns を 1〜{@link MAX_GRID_COUNT} の整数に丸める。NaN は 1。 */
export function clampGridCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_GRID_COUNT, Math.max(1, Math.floor(n)));
}

export function floorCell<T extends AreaCell>(cell: T): T {
  return {
    ...cell,
    x: Math.floor(cell.x),
    y: Math.floor(cell.y),
    width: Math.floor(cell.width),
    height: Math.floor(cell.height),
  };
}

export function floorArea<T extends Area>(area: T): T {
  const floored: T = {
    ...area,
    x: Math.floor(area.x),
    y: Math.floor(area.y),
    width: Math.floor(area.width),
    height: Math.floor(area.height),
  };
  if (area.positions) {
    floored.positions = area.positions.map((p) => floorCell(p));
  }
  if (area.padding !== undefined) {
    floored.padding = Math.floor(area.padding);
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
    scaled.padding = Math.max(0, area.padding * Math.min(scaleX, scaleY));
  }
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
      transform: {
        x: Math.floor(layer.transform.x * scaleX),
        y: Math.floor(layer.transform.y * scaleY),
        width: Math.floor(layer.transform.width * scaleX),
        height: Math.floor(layer.transform.height * scaleY),
      },
    };
  }
  return layer;
}

export function scaleStateForResolution(
  state: WallState,
  from: Resolution,
  to: Resolution,
): WallState {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return {
    ...state,
    resolution: to,
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
