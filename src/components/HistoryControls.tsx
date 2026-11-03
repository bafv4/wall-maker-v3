/**
 * HistoryControls — 取り消し / やり直しのボタンと、キーボードショートカット。
 *
 * Ctrl+Z で取り消し、Ctrl+Shift+Z / Ctrl+Y でやり直し（Mac は Cmd）。
 *  - 文字入力欄にフォーカスがあるときはブラウザ標準（入力中の文字の取り消し）に任せる。
 *  - モーダル表示中は効かせない（クロップ等の編集中に背後の内容が変わらないように）。
 * 履歴そのものは `store/history.ts`。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isMacPlatform } from '../adapters';
import { redo, undo, useHistoryStore } from '../store/history';
import { cn } from './ui/cn';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'number',
  'search',
  'email',
  'url',
  'tel',
  'password',
]);

function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

const IS_MAC = isMacPlatform();
const UNDO_KEYS = IS_MAC ? '⌘Z' : 'Ctrl+Z';
const REDO_KEYS = IS_MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z';

const buttonClass =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-fg-muted';

function ArrowIcon({ flip }: { flip?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4.5', flip && '-scale-x-100')}
      aria-hidden
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

export function HistoryControls() {
  const { t } = useTranslation();
  const canUndo = useHistoryStore((s) => s.past.length > 0);
  const canRedo = useHistoryStore((s) => s.future.length > 0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
      if (!isUndo && !isRedo) return;
      if (isTextEditing(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      if (isUndo) undo();
      else redo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={undo}
        disabled={!canUndo}
        className={buttonClass}
        aria-label={t('history.undo')}
        title={`${t('history.undo')} (${UNDO_KEYS})`}
      >
        <ArrowIcon />
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!canRedo}
        className={buttonClass}
        aria-label={t('history.redo')}
        title={`${t('history.redo')} (${REDO_KEYS})`}
      >
        <ArrowIcon flip />
      </button>
    </div>
  );
}
