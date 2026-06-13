/**
 * BinaryStorage のプラットフォーム判定セレクタ。
 * 仕様: REWRITE_SPEC.md 第4.4章（同じ判定で Tauri と Web を切り替える）。
 *
 * `@tauri-apps/*` を**静的 import しない**こと（Web バンドルがモジュール解決に失敗する）。
 * Desktop アダプタは動的 import で隔離する。
 */

import type { BinaryStorage } from './types';

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let cached: BinaryStorage | null = null;

export async function getBinaryStorage(): Promise<BinaryStorage> {
  if (cached) return cached;
  if (isTauri()) {
    const { DesktopBinaryStorage } = await import('./desktop');
    cached = new DesktopBinaryStorage();
  } else {
    const { WebBinaryStorage } = await import('./web');
    cached = new WebBinaryStorage();
  }
  return cached;
}

export type { BinaryStorage } from './types';
