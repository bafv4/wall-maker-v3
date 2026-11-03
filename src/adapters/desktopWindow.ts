/**
 * desktopWindow — ウィンドウ操作（最小化 / 最大化 / 閉じる）と最大化状態の監視（Desktop 専用）。
 *
 * Windows / Linux は OS のタイトルバーを消している（tauri.conf.json `decorations: false`）ので、
 * アプリのヘッダに置いた自前のボタンからここを呼ぶ。macOS は信号機ボタンを OS に任せる
 * （tauri.macos.conf.json の Overlay）ため使わない。
 *
 * `@tauri-apps/*` の静的 import はこのファイルに閉じる。到達経路は
 * `adapters/index.ts` からの動的 import のみ（Web バンドルには入らない）。
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export async function windowActionDesktop(action: WindowAction): Promise<void> {
  const win = getCurrentWindow();
  if (action === 'minimize') await win.minimize();
  else if (action === 'toggleMaximize') await win.toggleMaximize();
  else await win.close();
}

/**
 * 最大化状態を通知する。登録時に現在値を 1 回送り、以降はサイズ変更のたびに送る
 * （スナップやダブルクリックでの最大化もサイズ変更として届く）。戻り値で購読解除。
 */
export async function watchMaximizedDesktop(
  onChange: (maximized: boolean) => void,
): Promise<() => void> {
  const win = getCurrentWindow();
  onChange(await win.isMaximized());
  return win.onResized(async () => {
    onChange(await win.isMaximized());
  });
}
