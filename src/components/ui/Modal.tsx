/**
 * Minimum Modal — 背景クリック / Escape で閉じる、中央配置の薄いシェル。
 *
 * `createPortal` で `document.body` 直下にレンダリングする。
 * 深いネストの中で他の要素が stacking context を作っていても、Modal の z-index が常に
 * トップレベルで効くようになる。
 *
 * フォーカス（WAI-ARIA の modal dialog）:
 *  - 開いたらダイアログ自体へ移す（タイトルから読み上げられる。Tab で最初の操作へ進む）。
 *  - Tab / Shift+Tab はダイアログの中で循環させ、背後の画面へ抜けさせない。
 *  - 閉じたら開く前にフォーカスがあった要素へ戻す。
 */

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from './cn';
import { CloseIcon } from './icons';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** バックドロップクリックで閉じない（破壊的操作向け） */
  dismissOnBackdrop?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  dismissOnBackdrop = true,
}: ModalProps) {
  // 閉じるボタンはアイコン（×）だけなので、スクリーンリーダー向けのラベルは翻訳から取る。
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => {
      // 開いたボタンが消えている（リセット等で画面が組み変わった）ときは戻さない
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cn(
          'flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface shadow-xl focus:outline-none',
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        {title && (
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded p-1.5 text-fg-subtle hover:bg-muted hover:text-fg"
              aria-label={t('common.close')}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
