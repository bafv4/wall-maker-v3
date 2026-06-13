/**
 * Minimum Modal — 背景クリック / Escape で閉じる、中央配置の薄いシェル。
 *
 * `createPortal` で `document.body` 直下にレンダリングする。
 * 深いネストの中で他の要素が stacking context を作っていても、Modal の z-index が常に
 * トップレベルで効くようになる。
 */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** バックドロップクリックで閉じない（破壊的操作向け） */
  dismissOnBackdrop?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  dismissOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface shadow-xl',
          className,
        )}
        role="dialog"
        aria-modal="true"
      >
        {title && (
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded p-1.5 text-lg leading-none text-fg-subtle hover:bg-muted hover:text-fg"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
