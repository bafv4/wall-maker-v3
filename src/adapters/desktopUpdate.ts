/**
 * desktopUpdate — 更新通知とリリースアセットのダウンロード（Desktop 専用）。
 *
 * Rust 側 `update_check` / `update_download`（src-tauri/src/lib.rs）の薄いラッパ。
 * 方針は CLAUDE.md「自動更新なし」の範囲内: 自動適用はせず、
 *  1. 起動時に GitHub Releases の最新版と現在のバージョンを比較して通知する
 *  2. ユーザーが押したときだけ、配布形態（ポータブル / インストーラ）に合う
 *     アセットを**実行ファイルと同じフォルダ**へダウンロードする
 * 適用（インストーラ実行・exe の差し替え）はユーザー自身が行う。
 *
 * `@tauri-apps/*` の静的 import はこのファイルに閉じる。到達経路は
 * `adapters/index.ts` からの動的 import のみ（Web バンドルには入らない）。
 */

import { Channel, invoke } from '@tauri-apps/api/core';

export interface AppUpdateInfo {
  /** 最新版のバージョン（先頭 v なし。例 "3.3.0"） */
  version: string;
  /** リリースページ URL */
  releaseUrl: string;
  /** この配布形態に合うアセット。無ければ undefined（リリースページへ誘導） */
  assetName?: string | null;
  assetUrl?: string | null;
  assetSize?: number | null;
}

export interface AppUpdateProgress {
  received: number;
  /** Content-Length が取れないと null */
  total: number | null;
}

/** 最新版が現在より新しければその情報を、同じか古ければ null を返す。 */
export async function checkAppUpdateDesktop(
  currentVersion: string,
): Promise<AppUpdateInfo | null> {
  return invoke<AppUpdateInfo | null>('update_check', { currentVersion });
}

/**
 * アセットをダウンロードして保存した絶対パスを返す。
 * 進捗は 512KB ごとに `onProgress` へ届く（最後に必ず 1 回）。
 */
export async function downloadAppUpdateDesktop(
  url: string,
  fileName: string,
  onProgress: (p: AppUpdateProgress) => void,
): Promise<string> {
  const channel = new Channel<AppUpdateProgress>();
  channel.onmessage = onProgress;
  return invoke<string>('update_download', {
    url,
    fileName,
    onProgress: channel,
  });
}

/** 保存したファイルを OS のファイルマネージャで表示する（失敗は呼び出し側で握る）。 */
export async function revealDownloadedFile(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

/**
 * URL を OS 既定ブラウザで開く。Tauri webview 内の `<a target="_blank">` は
 * 環境によって何も起きないため、外部リンクは必ずこちらを使う。
 */
export async function openExternalUrlDesktop(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
