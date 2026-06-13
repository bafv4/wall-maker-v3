/**
 * layoutPresets — レイアウトのプリセット（旧アプリ `data/presets.ts` を参考に再構築）。
 *
 * プリセットは解像度非依存の **比率（0..1）** で定義し、現在の解像度に掛けて
 * 絶対 px に変換する。境界では `Math.floor` で整数化する（CLAUDE.md / 第6.3.1章：
 * 小数座標は SeedQueue が framebuffer 比率と誤解釈するため厳禁）。
 *
 * 旧アプリは preparing を単一オブジェクトで持っていたが、本アプリの state は
 * `preparing: VisibleArea[]`。プリセットの preparing は **show=true のときのみ**
 * 1 要素として展開し、false のときは空配列にする。
 *
 * 純粋関数のみ。React / store に依存しない（core の規約）。
 */

import type { MainArea, Resolution, VisibleArea } from './state';

/** プリセット 1 件分のレイアウト（main / locked / preparing[]）。 */
export interface PresetLayout {
  main: MainArea;
  locked: VisibleArea;
  preparing: VisibleArea[];
}

export interface LayoutPreset {
  /** 安定した識別子（Select の value / 翻訳キーに使用）。 */
  id: string;
  /** 表示名。 */
  name: string;
  layout: PresetLayout;
}

/** 比率（0..1）でのエリア定義。 */
interface AreaRatio {
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number;
  columns: number;
}

interface PresetRatio {
  id: string;
  name: string;
  main: AreaRatio;
  locked: AreaRatio & { show: boolean };
  preparing: AreaRatio & { show: boolean };
}

/**
 * 比率定義（旧アプリ `presetsRatio` 由来）。
 * x/y/width/height は画面幅・高さに対する割合。rows/columns は整数。
 */
const PRESET_RATIOS: readonly PresetRatio[] = [
  {
    id: 'default',
    name: 'Default',
    main: { x: 0, y: 0, width: 0.85, height: 1.0, rows: 4, columns: 3 },
    locked: {
      x: 0.85,
      y: 0,
      width: 0.15,
      height: 1.0,
      rows: 6,
      columns: 1,
      show: true,
    },
    preparing: {
      x: 0.792,
      y: 0,
      width: 0.208,
      height: 1.0,
      rows: 6,
      columns: 1,
      show: false,
    },
  },
  {
    id: 'priffie',
    name: 'Priffie',
    main: {
      x: 0.091,
      y: 0.028,
      width: 0.508,
      height: 0.944,
      rows: 3,
      columns: 2,
    },
    locked: {
      x: 0.635,
      y: 0.046,
      width: 0.318,
      height: 0.565,
      rows: 3,
      columns: 3,
      show: true,
    },
    preparing: {
      x: 0.018,
      y: 0.028,
      width: 0.068,
      height: 0.944,
      rows: 12,
      columns: 1,
      show: true,
    },
  },
  {
    id: 'dummy',
    name: 'Dummy',
    main: {
      x: 0.318,
      y: 0.659,
      width: 0.315,
      height: 0.338,
      rows: 2,
      columns: 2,
    },
    locked: {
      x: 0.85,
      y: 0.056,
      width: 0.117,
      height: 0.95,
      rows: 14,
      columns: 1,
      show: true,
    },
    preparing: {
      x: 0.125,
      y: 0.005,
      width: 0.7,
      height: 0.65,
      rows: 2,
      columns: 2,
      show: true,
    },
  },
];

/** 比率エリア → 絶対 px（Math.floor 整数化）。width/height は最低 1。 */
function scaleArea(ratio: AreaRatio, res: Resolution) {
  return {
    x: Math.floor(ratio.x * res.width),
    y: Math.floor(ratio.y * res.height),
    width: Math.max(1, Math.floor(ratio.width * res.width)),
    height: Math.max(1, Math.floor(ratio.height * res.height)),
    rows: ratio.rows,
    columns: ratio.columns,
    useGrid: true,
    padding: 0,
  };
}

/** 1 プリセットを現在の解像度に合わせて実 px のレイアウトへ展開する。 */
export function scalePreset(preset: PresetRatio, res: Resolution): PresetLayout {
  return {
    main: { ...scaleArea(preset.main, res), mainFillOrder: 'FORWARD' },
    locked: { ...scaleArea(preset.locked, res), show: preset.locked.show },
    // 旧アプリは単一 preparing。show=true のときのみ 1 要素で展開する。
    preparing: preset.preparing.show
      ? [{ ...scaleArea(preset.preparing, res), show: true }]
      : [],
  };
}

/** 現在の解像度に合わせた全プリセット（Select 表示用）。 */
export function getLayoutPresets(res: Resolution): LayoutPreset[] {
  return PRESET_RATIOS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    layout: scalePreset(preset, res),
  }));
}

/** アプリ初期状態に使う既定プリセットの id。 */
export const DEFAULT_PRESET_ID = 'default';

/**
 * 「Default」プリセットを指定解像度に展開したレイアウト。
 * 初期 state（`createDefaultWallState`）とプリセットメニューで同じ定義を共有する。
 */
export function getDefaultPresetLayout(res: Resolution): PresetLayout {
  const preset = PRESET_RATIOS.find((p) => p.id === DEFAULT_PRESET_ID);
  // PRESET_RATIOS は静的定義で必ず 'default' を含む（保険として最初の要素にフォールバック）。
  return scalePreset(preset ?? PRESET_RATIOS[0], res);
}
