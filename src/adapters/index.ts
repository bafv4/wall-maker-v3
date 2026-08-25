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
 * - `loadSaveTarget` / `rememberSaveTarget` / `forgetSaveTarget` は Desktop の
 *   「上書き保存」先をセッションを跨いで覚えるためのエントリ。Web では常に no-op。
 */

import type { PackReadSource, VirtualPack } from '../core/types';
// 型のみの import。`import type` は実行時に消えるため、Web バンドルへ
// `desktopSaveTarget`（= `@tauri-apps/*`）が引き込まれることはない。
import type { SaveTargetRestore } from './desktopSaveTarget';

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

// ---------------------------------------------------------------------------
// 保存先（上書き保存の対象フォルダ）の記憶 — Desktop のみ
// ---------------------------------------------------------------------------

export type { SaveTargetRestore };

/**
 * 前回の保存先を復元する（実在検証込み。詳細は `desktopSaveTarget.ts`）。
 * Web には保存先の概念が無いため常に `{ kind: 'none' }`。
 */
export async function loadSaveTarget(): Promise<SaveTargetRestore> {
  if (!isTauri()) return { kind: 'none' };
  const { readSaveTarget } = await import('./desktopSaveTarget');
  return readSaveTarget();
}

/** 保存先を記憶する。Web では何もしない。 */
export async function rememberSaveTarget(path: string): Promise<void> {
  if (!isTauri()) return;
  const { writeSaveTarget } = await import('./desktopSaveTarget');
  await writeSaveTarget(path);
}

/** 記憶した保存先を破棄する。Web では何もしない。 */
export async function forgetSaveTarget(): Promise<void> {
  if (!isTauri()) return;
  const { clearSaveTarget } = await import('./desktopSaveTarget');
  await clearSaveTarget();
}
