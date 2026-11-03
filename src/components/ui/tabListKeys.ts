/**
 * tablist のキー操作（WAI-ARIA Tabs、自動選択）。
 *
 * Tab キーでは選択中のタブにだけ止まり（他は tabIndex=-1）、矢印キーで隣のタブへ移って
 * そのまま選ぶ。Home / End で端へ。縦並び（md 以上のレール）と横並び（狭幅）の両方で
 * 使うので、上下左右の矢印をすべて受け付ける。端では反対側へ回り込む。
 * 選択は各タブの click で行う（タブ側の onClick をそのまま通す）。
 */

import type { KeyboardEvent } from 'react';

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

export function handleTabListKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (!NEXT_KEYS.has(e.key) && !PREV_KEYS.has(e.key) && e.key !== 'Home' && e.key !== 'End') {
    return;
  }
  const tabs = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not(:disabled)'),
  );
  const current = tabs.findIndex((tab) => tab === document.activeElement);
  if (current < 0) return;
  e.preventDefault();
  const last = tabs.length - 1;
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? last
        : NEXT_KEYS.has(e.key)
          ? current === last
            ? 0
            : current + 1
          : current === 0
            ? last
            : current - 1;
  tabs[next].focus();
  tabs[next].click();
}
