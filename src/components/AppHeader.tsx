/**
 * AppHeader — メイン領域上端のバー（Web / Desktop 共通）。タイトルとバージョン。
 *
 * インポート / エクスポート / リセットは「ファイル」タブ（`FileEditor`）に集約している。
 *
 * Desktop 版では OS のタイトルバーの代わりを兼ねる。空いている所を掴むとウィンドウを動かせ、
 * ダブルクリックで最大化する（`data-tauri-drag-region`。ボタン・リンクの上では効かない）。
 * Windows / Linux は右端に最小化・最大化・閉じる（`WindowControls`）を置き、macOS は
 * OS の信号機ボタンが左上（レールの上端）に重なる。
 *
 * タイトル部分をクリックすると AboutModal が開き、FFmpeg ライセンス表記・最新リリースへの
 * リンク等を表示する。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AboutModal } from './AboutModal';
import { WindowControls } from './WindowControls';

export function AppHeader({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <header className={className}>
      {/* 高さは罫線込みで 48px（左のエディタパネル見出しと揃える） */}
      <div
        data-tauri-drag-region
        className="flex h-12 items-center gap-3 border-b border-border px-5"
      >
        {/* 1 行に収める（折り返すとウィンドウ操作ボタンが 2 行目に落ちる）。狭いときはタイトルを省略表示 */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="min-w-0 cursor-pointer truncate rounded text-left text-base font-semibold text-fg hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title={t('header.aboutTooltip')}
          >
            {t('app.title')}
            {/* `__APP_VERSION__` は素の semver（package.json 由来）。`v` は表示側で付ける。 */}
            <span className="ml-2 text-xs font-normal text-fg-subtle">
              {`v${__APP_VERSION__}`}
            </span>
          </button>
        </div>
        {/* 右端に詰める（右の余白を打ち消し、罫線を除いた高さいっぱいに伸ばす） */}
        <WindowControls className="-mr-5 ml-auto flex-shrink-0 self-stretch" />
      </div>

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </header>
  );
}
