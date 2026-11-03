/**
 * dialogSpec — 別ウィンドウで開くダイアログの中身（Desktop 版）。
 *
 * ウィンドウ間では値しか渡せないので、ダイアログごとに表示に要る値をここで型にする。
 * `title` / `width` はウィンドウ自体の設定にも使う。
 */

import type { AreaCell, Resolution } from '../../core/state';
import type { ButtonVariant } from '../ui/Button';

interface DialogBase {
  title: string;
  /** ウィンドウの幅（論理 px）。高さは中身に合わせる。 */
  width: number;
}

export type DialogSpec =
  | (DialogBase & { kind: 'about' })
  | (DialogBase & {
      kind: 'confirm';
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      confirmVariant?: ButtonVariant;
    })
  | (DialogBase & {
      kind: 'importResolution';
      fileName: string;
      suggested: Resolution | null;
      current: Resolution;
    })
  | (DialogBase & {
      kind: 'crop';
      /** 現在の切り抜き範囲（画像の自然 px）。null なら画像全体。 */
      crop: AreaCell | null;
    })
  | (DialogBase & {
      kind: 'update';
      version: string;
      currentVersion: string;
      releaseUrl: string;
      /** 対応アセットが無いリリースでは null（リリースページへのリンクだけ出す）。 */
      assetName: string | null;
      assetSize: number | null;
    });

/** 更新のダウンロード／適用の進み具合。 */
export type UpdateDownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'done'; path: string }
  /** ワンクリック更新: ダウンロード〜差し替え中 */
  | { kind: 'applying'; percent: number | null }
  /** 差し替え済み。永続化を書き切って再起動中 */
  | { kind: 'restarting' }
  /** 差し替え済みだが再起動に失敗（手動で起動し直せば新版になる） */
  | { kind: 'applied' };

/**
 * URL に載せるには大きい値（画像など）。開いた直後に 1 回だけイベントで渡す。
 * `imageUrl` は data URL（blob URL はウィンドウをまたいで使えない）。
 */
export interface DialogPayload {
  imageUrl?: string;
}

/** 開いた後にメイン側で変わる値（実行中フラグなど）。 */
export interface DialogState {
  busy?: boolean;
  exporting?: boolean;
  /** 更新ダイアログ: 進み具合と、ワンクリック更新を出すか。 */
  update?: { download: UpdateDownloadState; autoApply: boolean };
}

/**
 * ダイアログ → メインへの通知。
 *  - `ready`: 描画できた（初期 state を受け取る合図）。
 *  - `result`: 確定（値はダイアログごと。確認なら無し、インポートなら解像度）。
 *  - `dismiss`: × / Esc / キャンセル / OS からの閉じる要求。
 *  - `action`: ダイアログを閉じずにメイン側で行う操作（言語の切り替え、先にエクスポート）。
 */
export type DialogMessage =
  | { type: 'ready' }
  | { type: 'result'; value?: unknown }
  | { type: 'dismiss' }
  | { type: 'action'; name: string; value?: unknown };

/** 別ウィンドウのダイアログとして開かれたときの指定（URL の `?dialog=`）。それ以外は null。 */
export function readDialogParams(): { spec: DialogSpec; id: string } | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dialog');
  const id = params.get('dialogId');
  if (!raw || !id) return null;
  try {
    return { spec: JSON.parse(raw) as DialogSpec, id };
  } catch {
    return null;
  }
}
