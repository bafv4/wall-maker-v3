/**
 * desktopDialog — ダイアログを別ウィンドウで開く（Desktop 専用）。
 *
 * Desktop 版では About・確認・インポート解像度などのダイアログを、アプリ内の重ね表示ではなく
 * OS のタイトルバーを持たない子ウィンドウとして出す。ウィンドウ間では React ツリーも store も
 * 共有できないので、内容は `DialogSpec`（シリアライズ可能な値）として URL で渡し、
 * 操作の結果はイベントでメインウィンドウへ返す。
 *
 * やり取り:
 *  - ダイアログ → メイン: `dialog://message`（`result` / `dismiss` / `action`）。
 *  - メイン → ダイアログ: `dialog://payload`（画像など URL に載らない値。開いた直後に 1 回）と
 *    `dialog://state`（実行中フラグなど、開いた後に変わる値）。
 *  - ダイアログは自分では閉じない。閉じるのは常にメイン側（`handle.close()`）。
 *    × / Esc / Alt+F4 も `dismiss` を送るだけにして、閉じてよいかはメイン側の state で決める
 *    （インポート処理中のように、閉じられては困る間がある）。
 *  - 開いている間はメインウィンドウを無効化し、モーダルとして振る舞わせる。
 *
 * `@tauri-apps/*` の静的 import はこのファイルに閉じる。到達経路は
 * `adapters/index.ts` からの動的 import のみ（Web バンドルには入らない）。
 */

import { emitTo, listen } from '@tauri-apps/api/event';
import { LogicalSize } from '@tauri-apps/api/dpi';
import {
  WebviewWindow,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow';
import type {
  DialogMessage,
  DialogPayload,
  DialogSpec,
  DialogState,
} from '../components/dialogs/dialogSpec';

const MAIN_LABEL = 'main';
const MESSAGE_EVENT = 'dialog://message';
const STATE_EVENT = 'dialog://state';
const PAYLOAD_EVENT = 'dialog://payload';

export interface DialogWindowHandle {
  update(state: DialogState): void;
  close(): void;
}

export interface DialogWindowHandlers {
  onMessage(message: DialogMessage): void;
}

/** メイン側: ダイアログウィンドウを開く。 */
export async function openDialogWindowDesktop(
  spec: DialogSpec,
  state: DialogState,
  handlers: DialogWindowHandlers,
  payload?: DialogPayload,
): Promise<DialogWindowHandle> {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const label = `dialog-${id}`;
  const main = getCurrentWebviewWindow();
  let latest = state;

  const unlisten = await listen<DialogMessage & { id: string }>(
    MESSAGE_EVENT,
    (e) => {
      if (e.payload.id !== id) return;
      // 開いた直後の初期 state はここで渡す（URL に載せると開いた後の変化と二重管理になる）
      if (e.payload.type === 'ready') {
        if (payload) void emitTo(label, PAYLOAD_EVENT, payload);
        void emitTo(label, STATE_EVENT, latest);
      }
      handlers.onMessage(e.payload);
    },
  );

  const params = new URLSearchParams({
    dialog: JSON.stringify(spec),
    dialogId: id,
  });
  const win = new WebviewWindow(label, {
    url: `/?${params.toString()}`,
    parent: main,
    title: spec.title,
    width: spec.width,
    height: 240,
    center: true,
    decorations: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // 中身の高さに合わせてから表示する（ダイアログ側が show する）
    visible: false,
  });

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unlisten();
    void main.setEnabled(true).then(() => main.setFocus());
  };
  void win.once('tauri://destroyed', finish);
  void win.once('tauri://error', (e) => {
    console.warn('dialog window failed', e.payload);
    finish();
    handlers.onMessage({ type: 'dismiss' });
  });
  await main.setEnabled(false);

  return {
    update(next) {
      latest = next;
      if (!closed) void emitTo(label, STATE_EVENT, next);
    },
    close() {
      void win.destroy().catch(() => undefined);
      finish();
    },
  };
}

/** ダイアログ側: メインとのやり取りと、自分のウィンドウの表示を扱う。 */
export function dialogBridgeDesktop(id: string) {
  const win = getCurrentWebviewWindow();
  return {
    send(message: DialogMessage): void {
      void emitTo(MAIN_LABEL, MESSAGE_EVENT, { ...message, id });
    },
    async onPayload(cb: (payload: DialogPayload) => void): Promise<() => void> {
      return win.listen<DialogPayload>(PAYLOAD_EVENT, (e) => cb(e.payload));
    },
    async onState(cb: (state: DialogState) => void): Promise<() => void> {
      return win.listen<DialogState>(STATE_EVENT, (e) => cb(e.payload));
    },
    /** Alt+F4 などの OS からの閉じる要求を、閉じずに `dismiss` として送る。 */
    async interceptClose(): Promise<() => void> {
      return win.onCloseRequested((e) => {
        e.preventDefault();
        void emitTo(MAIN_LABEL, MESSAGE_EVENT, { type: 'dismiss', id });
      });
    },
    /** 高さを中身に合わせる（幅は開いたときのまま）。 */
    async setHeight(height: number): Promise<void> {
      const { width } = (await win.innerSize()).toLogical(
        await win.scaleFactor(),
      );
      await win.setSize(new LogicalSize(width, height));
    },
    /** 最初の高さを合わせた後に、中央へ置いて表示する。 */
    async show(): Promise<void> {
      await win.center();
      await win.show();
      await win.setFocus();
    },
  };
}

export type DialogBridge = ReturnType<typeof dialogBridgeDesktop>;
