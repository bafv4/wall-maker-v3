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
 * App ルートに `<ToastRoot />` を 1 度だけマウントする。
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

let nextId = 1;
const enqueue = (message: string, type: ToastType): void => {
  if (!pusher) {
    if (type === 'error') console.error(message);
    else console.info(message);
    return;
  }
  pusher({ id: nextId++, message, type });
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
    pusher = (item) => {
      setItems((prev) => [...prev, item]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      }, 4000);
    };
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
