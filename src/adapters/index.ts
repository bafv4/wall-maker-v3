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

import type { PackReadResult, PackReadSource } from '../core/types';
// 型のみの import。`import type` は実行時に消えるため、Web バンドルへ
// `desktopSaveTarget`（= `@tauri-apps/*`）が引き込まれることはない。
import type { SaveTargetRestore } from './desktopSaveTarget';
import type { AppUpdateInfo, AppUpdateProgress } from './desktopUpdate';

export type { AppUpdateInfo, AppUpdateProgress } from './desktopUpdate';

export type { PackReadResult, PackReadSource } from '../core/types';

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
export async function readPack(
  source: PackReadSource,
): Promise<PackReadResult> {
  if (isTauri()) {
    const { readDesktopPack } = await import('./desktop');
    return readDesktopPack(source);
  }
  const { readWebPack } = await import('./web');
  return { pack: await readWebPack(source), rootPath: null };
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

// ---------------------------------------------------------------------------
// 更新通知（Desktop のみ。Web はリロードで常に最新なので no-op）
// ---------------------------------------------------------------------------

/**
 * 最新リリースをチェックし、現在より新しければ情報を返す。Web では常に null。
 * ネットワーク失敗は throw する（呼び出し側は通知を出さず console に留めること）。
 */
export async function checkAppUpdate(
  currentVersion: string,
): Promise<AppUpdateInfo | null> {
  if (!isTauri()) return null;
  const { checkAppUpdateDesktop } = await import('./desktopUpdate');
  return checkAppUpdateDesktop(currentVersion);
}

/**
 * リリースアセットを実行ファイルと同じフォルダへダウンロードし、保存パスを返す。
 * Desktop 専用（Web から呼ぶと reject）。
 */
export async function downloadAppUpdate(
  url: string,
  fileName: string,
  onProgress: (p: AppUpdateProgress) => void,
): Promise<string> {
  if (!isTauri()) throw new Error('downloadAppUpdate は Desktop 専用です');
  const { downloadAppUpdateDesktop } = await import('./desktopUpdate');
  return downloadAppUpdateDesktop(url, fileName, onProgress);
}

/** 保存済みファイルを OS のファイルマネージャで表示する（Desktop 専用、失敗は無視してよい）。 */
export async function revealAppUpdateFile(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealDownloadedFile } = await import('./desktopUpdate');
  await revealDownloadedFile(path);
}

/**
 * 外部 URL を既定ブラウザで開く。Desktop は opener プラグイン経由
 * （webview 内アンカーの `target=_blank` は環境依存で無反応になるため）、
 * Web は通常の新規タブ。
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openExternalUrlDesktop } = await import('./desktopUpdate');
    await openExternalUrlDesktop(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
