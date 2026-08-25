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
 *
 * `<ToastRoot />` は React ルート（`main.tsx`）に 1 度だけマウントする。App の中に置くと
 * ハイドレート待ちの early return より後ろになり、store 復元失敗の通知を出せなくなる。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type ToastType = 'info' | 'error' | 'success';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

type Pusher = (item: ToastItem) => void;
let pusher: Pusher | null = null;

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
const enqueue = (message: string, type: ToastType): void => {
  const item: ToastItem = { id: nextId++, message, type };
  if (!pusher) {
    if (type === 'error') console.error(message);
    else console.info(message);
    if (pending.length < PENDING_LIMIT) pending.push(item);
    return;
  }
  pusher(item);
};

export const toast = {
  info: (msg: string) => enqueue(msg, 'info'),
  error: (msg: string) => enqueue(msg, 'error'),
  success: (msg: string) => enqueue(msg, 'success'),
};

const STYLE: Record<ToastType, string> = {
  info: 'bg-neutral-800 text-white',
  error: 'bg-red-600 text-white',
  success: 'bg-emerald-600 text-white',
};

export function ToastRoot() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const push: Pusher = (item) => {
      setItems((prev) => [...prev, item]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      }, 4000);
    };
    pusher = push;
    // マウント前に積まれた分を取り出して表示する。splice で空にするので
    // StrictMode の二重 effect でも重複しない。
    for (const item of pending.splice(0, pending.length)) push(item);
    return () => {
      pusher = null;
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={cn(
            'pointer-events-auto rounded-md px-4 py-2.5 text-sm shadow-lg',
            STYLE[item.type],
          )}
        >
          {item.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
