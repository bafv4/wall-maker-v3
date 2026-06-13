/**
 * adapter エントリ — プラットフォーム判定 + ファイル I/O の環境吸収。
 *
 * 仕様: CLAUDE.md「プラットフォーム判定とアダプタ選択」。
 *
 * - Tauri webview 判定は `__TAURI_INTERNALS__` の有無で行う（同期取得可能）。
 * - **Desktop モジュールは動的 import で隔離**する。`@tauri-apps/*` を静的に取り込むと
 *   Web バンドルがモジュール解決に失敗するため。
 * - `saveZipBytes` / `readPack` は環境ごとの差をここで吸収する単一エントリ。Writer/Reader
 *   クラスのような抽象は持たない（実装が 2 つしかなく、構造が同じだったため）。
 */

import type { PackReadSource, VirtualPack } from '../core/types';

export type { PackReadSource } from '../core/types';

/** Tauri webview 内で動作しているかの判定。SSR / Node では false。 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 完成済みの zip バイト列を環境固有の出力先に書き出す。
 * - Web      : ダウンロード（同期、キャンセル不可）
 * - Desktop  : `.zip` 保存ダイアログ → Rust `write_file` command（キャンセル時 null）
 *
 * 戻り値はユーザ通知用の表示名（ファイル名 / 絶対パス）。
 */
export async function saveZipBytes(
  zipBytes: Uint8Array,
  packName: string,
): Promise<string | null> {
  if (isTauri()) {
    const { saveZipBytesViaDialog } = await import('./desktop');
    return saveZipBytesViaDialog(zipBytes, packName);
  }
  const { saveZipBytesAsDownload } = await import('./web');
  return saveZipBytesAsDownload(zipBytes, packName);
}

/**
 * `PackReadSource` を VirtualPack に展開する。Web は `webZip` のみ、Desktop は
 * `desktopZip` / `desktopFolder` を扱う。非対応 kind は実装側で明示エラーになる。
 */
export async function readPack(source: PackReadSource): Promise<VirtualPack> {
  if (isTauri()) {
    const { readDesktopPack } = await import('./desktop');
    return readDesktopPack(source);
  }
  const { readWebPack } = await import('./web');
  return readWebPack(source);
}
