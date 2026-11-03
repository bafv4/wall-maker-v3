/**
 * 最小限のグローバル Toast。
 * CLAUDE.md「alert() を使わずトースト等の非ブロッキング表示に統一」を実現する。
 *
 * `createPortal` で `document.body` 直下に出力し、Modal（z-50）より前面（z-60）に置く。
 *
 * 使用例:
 *   import { toast } from './ui/Toast';
 *   toast.error('変換に失敗しました');
 *   toast.info('保存しました');
 *   toast.info('削除しました', { action: { label: '元に戻す', onClick: undo } });
 *
 * 操作ボタン（`action`）付きは押す時間を残すため長めに出す。押すと閉じる。
 * エラーは読み切る前に消えないよう、閉じるボタンで閉じるまで残す（読み上げは即時の alert）。
 * それ以外は常設の polite なライブ領域に積んで読み上げさせる。
 *
 * `<ToastRoot />` は React ルート（`main.tsx`）に 1 度だけマウントする。App の中に置くと
 * ハイドレート待ちの early return より後ろになり、store 復元失敗の通知を出せなくなる。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from './cn';
import { CloseIcon } from './icons';

type ToastType = 'info' | 'error' | 'success';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

const DURATION_MS = 4000;
const ACTION_DURATION_MS = 8000;

type Pusher = (item: ToastItem) => void;
let pusher: Pusher | null = null;
let dismisser: ((id: number) => void) | null = null;

/**
 * ToastRoot がマウントされる前に積まれたトーストのバッファ。
 * store の hydration（`persistAdapter` の getItem）は React の初回レンダーより前に走るため、
 * そのまま捨てると「復元に失敗した」通知がユーザーに一度も届かない。ここに溜めておき、
 * ToastRoot のマウント時に flush する。
 * マウントされないまま溜まり続けないよう件数は上限で打ち切る。
 */
const PENDING_LIMIT = 10;
const pending: ToastItem[] = [];

let nextId = 1;
/** 積んだトーストの id を返す（`toast.dismiss` 用）。 */
const enqueue = (
  message: string,
  type: ToastType,
  options?: ToastOptions,
): number => {
  const item: ToastItem = { id: nextId++, message, type, action: options?.action };
  if (!pusher) {
    if (type === 'error') console.error(message);
    else console.info(message);
    if (pending.length < PENDING_LIMIT) pending.push(item);
    return item.id;
  }
  pusher(item);
  return item.id;
};

export const toast = {
  info: (msg: string, options?: ToastOptions) => enqueue(msg, 'info', options),
  error: (msg: string, options?: ToastOptions) =>
    enqueue(msg, 'error', options),
  success: (msg: string, options?: ToastOptions) =>
    enqueue(msg, 'success', options),
  /** 表示中（またはマウント前に積まれた）トーストを閉じる。既に消えていれば何もしない。 */
  dismiss: (id: number) => {
    const i = pending.findIndex((p) => p.id === id);
    if (i >= 0) pending.splice(i, 1);
    dismisser?.(id);
  },
};

const STYLE: Record<ToastType, string> = {
  info: 'bg-neutral-800 text-white',
  error: 'bg-red-600 text-white',
  success: 'bg-emerald-600 text-white',
};

export function ToastRoot() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const dismiss = (id: number) =>
      setItems((prev) => prev.filter((i) => i.id !== id));
    const push: Pusher = (item) => {
      setItems((prev) => [...prev, item]);
      if (item.type === 'error') return;
      window.setTimeout(
        () => dismiss(item.id),
        item.action ? ACTION_DURATION_MS : DURATION_MS,
      );
    };
    pusher = push;
    dismisser = dismiss;
    // マウント前に積まれた分を取り出して表示する。splice で空にするので
    // StrictMode の二重 effect でも重複しない。
    for (const item of pending.splice(0, pending.length)) push(item);
    return () => {
      pusher = null;
      dismisser = null;
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-[min(32rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.type === 'error' ? 'alert' : undefined}
          className={cn(
            'pointer-events-auto flex items-center gap-3 rounded-md px-4 py-2.5 text-sm shadow-lg',
            STYLE[item.type],
          )}
        >
          <span className="min-w-0 flex-1">{item.message}</span>
          {item.action && (
            <button
              type="button"
              onClick={() => {
                dismisser?.(item.id);
                item.action?.onClick();
              }}
              // 背景色は種別ごとに違うので、色は継承して下線で操作できることを示す
              className="-my-1 -mr-2 shrink-0 cursor-pointer rounded px-2 py-1 font-semibold underline decoration-white/50 underline-offset-2 hover:bg-white/15 hover:decoration-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {item.action.label}
            </button>
          )}
          {item.type === 'error' && (
            <button
              type="button"
              onClick={() => dismisser?.(item.id)}
              aria-label={t('common.close')}
              className="-my-1 -mr-2 shrink-0 cursor-pointer rounded p-1 text-white/80 hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
