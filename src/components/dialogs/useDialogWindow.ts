/**
 * useDialogWindow — Desktop 版で、ダイアログを別ウィンドウとして開いている間だけ保つ。
 *
 * `open` が true の間ウィンドウを 1 つ開き、false になったら閉じる。`spec` は開いた時点の値を使い、
 * 開いた後に変わる値は `state` で送る。画像など大きい値は `payload` で、開くときに 1 回だけ作って渡す。Web では何もしない（各ダイアログはアプリ内の Modal を使う）。
 */

import { useEffect, useRef } from 'react';
import { isTauri, openDialogWindow } from '../../adapters';
import type {
  DialogMessage,
  DialogPayload,
  DialogSpec,
  DialogState,
} from './dialogSpec';

export const opensDialogWindows = isTauri();

interface Options {
  open: boolean;
  spec: DialogSpec;
  state?: DialogState;
  payload?: () => Promise<DialogPayload>;
  onMessage: (message: DialogMessage) => void;
}

export function useDialogWindow({
  open,
  spec,
  state = {},
  payload,
  onMessage,
}: Options) {
  const latest = useRef({ spec, state, payload, onMessage });
  useEffect(() => {
    latest.current = { spec, state, payload, onMessage };
  });
  const handleRef = useRef<{ update(s: DialogState): void } | null>(null);
  const stateKey = JSON.stringify(state);

  useEffect(() => {
    if (!opensDialogWindows || !open) return;
    let disposed = false;
    let handle: Awaited<ReturnType<typeof openDialogWindow>> | null = null;
    void (async () => {
      const payload = await latest.current.payload?.();
      if (disposed) throw new Error('disposed');
      return openDialogWindow(
        latest.current.spec,
        latest.current.state,
        { onMessage: (m) => latest.current.onMessage(m) },
        payload,
      );
    })()
      .then((h) => {
        if (disposed) h.close();
        else handle = handleRef.current = h;
      })
      .catch((err: unknown) => {
        if (disposed) return;
        console.warn('open dialog window failed', err);
        latest.current.onMessage({ type: 'dismiss' });
      });
    return () => {
      disposed = true;
      handleRef.current = null;
      handle?.close();
    };
  }, [open]);

  useEffect(() => {
    handleRef.current?.update(JSON.parse(stateKey) as DialogState);
  }, [stateKey]);
}
