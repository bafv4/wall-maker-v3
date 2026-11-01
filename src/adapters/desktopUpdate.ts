/**
 * desktopUpdate — 更新通知・リリースアセットのダウンロード・ワンクリック更新（Desktop 専用）。
 *
 * Rust 側 `update_check` / `update_download` / `update_apply_portable` /
 * `update_relaunch`（src-tauri/src/update.rs）の薄いラッパ。方針:
 *  1. 起動時に GitHub Releases の最新版と現在のバージョンを比較して通知する
 *  2. Windows ポータブル版（`canAutoApply`）は、ユーザーが押したときだけ
 *     exe をダウンロード・SHA-256 検証・差し替えして再起動する
 *  3. それ以外は、ユーザーが押したときだけ配布形態（ポータブル / インストーラ）に
 *     合うアセットを**実行ファイルと同じフォルダ**へダウンロードする（適用はユーザー自身）
 *
 * `@tauri-apps/*` の静的 import はこのファイルに閉じる。到達経路は
 * `adapters/index.ts` からの動的 import のみ（Web バンドルには入らない）。
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

export interface AppUpdateInfo {
  /** 最新版のバージョン（先頭 v なし。例 "3.3.0"） */
  version: string;
  /** 実行中のバージョン（tauri.conf.json の `version`） */
  currentVersion: string;
  /** リリースページ URL */
  releaseUrl: string;
  /** この配布形態に合うアセット。無ければ undefined（リリースページへ誘導） */
  assetName?: string | null;
  assetUrl?: string | null;
  assetSize?: number | null;
  /** ワンクリック更新（{@link applyPortableUpdateDesktop}）が使えるか */
  canAutoApply: boolean;
}

export interface AppUpdateProgress {
  received: number;
  /** Content-Length が取れないと null */
  total: number | null;
}

/** 最新版が現在より新しければその情報を、同じか古ければ null を返す。 */
export async function checkAppUpdateDesktop(): Promise<AppUpdateInfo | null> {
  return invoke<AppUpdateInfo | null>('update_check');
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

/**
 * 最新版の exe をダウンロード・検証して差し替える（Windows ポータブル版のみ）。
 * URL は渡さない（Rust 側で最新リリースを取り直して判定する）。
 */
export async function applyPortableUpdateDesktop(
  onProgress: (p: AppUpdateProgress) => void,
): Promise<void> {
  const channel = new Channel<AppUpdateProgress>();
  channel.onmessage = onProgress;
  await invoke('update_apply_portable', { onProgress: channel });
}

/** 差し替えた exe を起動してこのプロセスを終了する。 */
export async function relaunchAfterUpdateDesktop(): Promise<void> {
  await invoke('update_relaunch');
}

/** 保存したファイルを OS のファイルマネージャで表示する（失敗は呼び出し側で握る）。 */
export async function revealDownloadedFile(path: string): Promise<void> {
  await revealItemInDir(path);
}

/**
 * URL を OS 既定ブラウザで開く。Tauri webview 内の `<a target="_blank">` は
 * 環境によって何も起きないため、外部リンクは必ずこちらを使う。
 */
export async function openExternalUrlDesktop(url: string): Promise<void> {
  await openUrl(url);
}
