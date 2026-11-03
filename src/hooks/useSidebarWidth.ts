/**
 * useSidebarWidth — サイドバー（エディタパネル）の幅の state と保存。
 *
 * 幅は閲覧者ごとの見た目の好みなので localStorage に覚える（読めない環境では毎回既定幅）。
 * 表示時の CSS 値は、プレビュー側に最低 MIN_MAIN_WIDTH px 残るように抑える
 * （ウィンドウを縮めたときに保存値が大きすぎてもプレビューが潰れない）。
 */

import { useState } from 'react';

const STORAGE_KEY = 'wall-maker:sidebar-width';
/** これより狭いとファイルタブのボタンやエリアの 2 列入力が窮屈になる。 */
export const MIN_SIDEBAR_WIDTH = 320;
export const MAX_SIDEBAR_WIDTH = 720;
/** プレビュー列に最低限残す幅（レール 84px は別）。 */
const MIN_MAIN_WIDTH = 360;
const RAIL_WIDTH = 84;
/** 未設定時の幅（画面幅の 30%、320〜420px）。 */
export const DEFAULT_SIDEBAR_WIDTH_CSS = 'clamp(320px, 30vw, 420px)';

export const clampSidebarWidth = (w: number) =>
  Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w)));

function loadWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? clampSidebarWidth(v) : null;
  } catch {
    return null;
  }
}

export function saveSidebarWidth(w: number | null) {
  try {
    if (w == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(w));
  } catch {
    // 保存できなくても幅の変更自体は続ける
  }
}

/** サイドバー幅の state と、グリッドに渡す CSS 値。 */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number | null>(loadWidth);
  const cssWidth =
    width == null
      ? DEFAULT_SIDEBAR_WIDTH_CSS
      : `max(${MIN_SIDEBAR_WIDTH}px, min(${width}px, calc(100vw - ${RAIL_WIDTH + MIN_MAIN_WIDTH}px)))`;
  return { width, setWidth, cssWidth };
}
