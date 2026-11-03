/**
 * AppRail — 画面左端の縦ナビ（編集項目の切替）。
 *
 * md 以上は縦 1 列のレール（アイコン＋ラベル）、狭幅では横 1 行のバーになる。
 * 項目は App の `Tabs` と同じ値（file/info/layout/…）を切り替えるタブで、本文は
 * 右隣のエディタパネルに出る。リセットなどのファイル操作は先頭の「ファイル」タブにある。
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './ui';
import { handleTabListKeyDown } from './ui/tabListKeys';

export type EditorTab = 'file' | 'info' | 'layout' | 'background' | 'lock' | 'sound';

/** 24px グリッドの線アイコン。線幅とキャップを全アイコンで揃える。 */
function RailIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const TAB_ICONS: Record<EditorTab, ReactNode> = {
  // フォルダ
  file: (
    <path d="M3.75 7.5a1.5 1.5 0 0 1 1.5-1.5h4.19a1.5 1.5 0 0 1 1.06.44l1.06 1.06h7.19a1.5 1.5 0 0 1 1.5 1.5v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V7.5Z" />
  ),
  // 箱（リソースパック）
  info: (
    <>
      <path d="M12 3.75 19.5 7.5v9L12 20.25 4.5 16.5v-9L12 3.75Z" />
      <path d="M4.5 7.5 12 11.25l7.5-3.75M12 11.25v9" />
    </>
  ),
  // ウォール（メインの格子＋右のグループ列）
  layout: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" />
      <path d="M15.75 5.25v13.5M9.75 5.25v13.5M3.75 12h12" />
    </>
  ),
  // 画像
  background: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" />
      <circle cx="9" cy="9.75" r="1.5" />
      <path d="m3.75 16.5 4.5-4.5 3 3 3.75-3.75 5.25 5.25" />
    </>
  ),
  // 錠
  lock: (
    <>
      <rect x="5.25" y="10.5" width="13.5" height="9.75" rx="1.5" />
      <path d="M8.25 10.5V7.5a3.75 3.75 0 0 1 7.5 0v3" />
    </>
  ),
  // スピーカー
  sound: (
    <>
      <path d="M4.5 9.75h3L12 6v12l-4.5-3.75h-3a.75.75 0 0 1-.75-.75v-3a.75.75 0 0 1 .75-.75Z" />
      <path d="M15.75 9.5a3.5 3.5 0 0 1 0 5M18 7.25a6.75 6.75 0 0 1 0 9.5" />
    </>
  ),
};

const itemClass =
  'flex w-[72px] shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md px-0.5 py-2 text-xs font-medium leading-tight transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 md:w-full';

export interface AppRailProps {
  tabs: readonly EditorTab[];
  value: EditorTab;
  onValueChange: (next: EditorTab) => void;
  className?: string;
}

export function AppRail({
  tabs,
  value,
  onValueChange,
  className,
}: AppRailProps) {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t('tab.listLabel')}
      className={cn(
        'flex gap-1 overflow-x-auto border-b border-border bg-surface p-1.5',
        'md:flex-col md:overflow-x-hidden md:overflow-y-auto md:border-r md:border-b-0',
        className,
      )}
    >
      {/* ブランドマーク。狭幅では上のヘッダにタイトルがあるので出さない */}
      <div className="hidden h-12 flex-shrink-0 items-center justify-center md:flex">
        <img
          src={`${import.meta.env.BASE_URL}icon.svg`}
          alt=""
          className="h-8 w-8 rounded-md"
        />
      </div>
      <div
        role="tablist"
        onKeyDown={handleTabListKeyDown}
        className="flex gap-1 md:flex-col"
      >
        {tabs.map((tab) => {
          const active = tab === value;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onValueChange(tab)}
              className={cn(
                itemClass,
                active
                  ? 'bg-accent-soft text-accent-soft-fg'
                  : 'text-fg-muted hover:bg-muted hover:text-fg',
              )}
            >
              <RailIcon>{TAB_ICONS[tab]}</RailIcon>
              <span className="text-center">{t(`tab.${tab}`)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

