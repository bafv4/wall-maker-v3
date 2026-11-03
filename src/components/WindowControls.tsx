/**
 * WindowControls — Windows / Linux の Desktop 版でヘッダ右端に置く「最小化 / 最大化 / 閉じる」。
 *
 * OS のタイトルバーは消している（tauri.conf.json `decorations: false`）ので、その代わり。
 * Windows のキャプションボタンに倣い、ヘッダの高さいっぱい・右端に詰めて並べ、
 * 閉じるだけ hover で赤地にする。macOS は OS の信号機ボタン（左上）を使うので出さない。
 * Web でも出さない。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isMacDesktop,
  isTauri,
  watchWindowMaximized,
  windowAction,
} from '../adapters';
import { cn } from './ui';

const buttonClass =
  'flex h-full w-12 cursor-default items-center justify-center text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500';

function run(action: Parameters<typeof windowAction>[0]) {
  void windowAction(action).catch((err: unknown) => {
    console.warn('window action failed', action, err);
  });
}

/** 10px 四方の細線アイコン（Windows のキャプションボタンと同じ細さ・大きさ）。 */
function CaptionIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      shapeRendering="crispEdges"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function WindowControls({ className }: { className?: string }) {
  const { t } = useTranslation();
  const show = isTauri() && !isMacDesktop();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!show) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void watchWindowMaximized(setMaximized)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        console.warn('watch maximized failed', err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [show]);

  if (!show) return null;

  const maximizeLabel = maximized ? t('window.restore') : t('window.maximize');
  return (
    <div className={cn('flex', className)}>
      <button
        type="button"
        onClick={() => run('minimize')}
        className={cn(buttonClass, 'hover:bg-muted hover:text-fg')}
        aria-label={t('window.minimize')}
        title={t('window.minimize')}
      >
        <CaptionIcon>
          <path d="M0 5.5h10" />
        </CaptionIcon>
      </button>
      <button
        type="button"
        onClick={() => run('toggleMaximize')}
        className={cn(buttonClass, 'hover:bg-muted hover:text-fg')}
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        <CaptionIcon>
          {maximized ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" />
          )}
        </CaptionIcon>
      </button>
      <button
        type="button"
        onClick={() => run('close')}
        className={cn(buttonClass, 'hover:bg-[#c42b1c] hover:text-white')}
        aria-label={t('window.close')}
        title={t('window.close')}
      >
        <CaptionIcon>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </CaptionIcon>
      </button>
    </div>
  );
}
