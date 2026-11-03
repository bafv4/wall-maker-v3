/**
 * AppHeader — メイン領域上端のバー。タイトル＋Import/Export（Web 用）。
 *
 * リセットはエクスポートの隣で押し間違えないよう、左端のレール（`AppRail`）の下端に置く。
 * Desktop ではこのコンポーネントは表示せず、ファイル操作は「ファイル」タブ
 * （`FileEditor`）に集約される（App.tsx で isTauri() 判定）。
 *
 * 状態とハンドラはすべて `useFileOperations()` 越しに取得する。Provider が
 * Import 用の hidden `<input>` と解像度選択ダイアログをまとめてマウントしている
 * ため、本コンポーネントはボタンを並べるだけで済む。
 *
 * タイトル部分をクリックすると AboutModal が開き、FFmpeg ライセンス表記等を表示する。
 * タイトルの右隣には GitHub の最新リリースページ（/releases/latest）への外部リンクを置く。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileOperations } from '../hooks/useFileOperations';
import { AboutModal } from './AboutModal';
import { Button } from './ui';

/** GitHub の最新リリースページ。タグを固定しないよう /releases/latest を使う。 */
const LATEST_RELEASE_URL =
  'https://github.com/bafv4/wall-maker-v3/releases/latest';

export function AppHeader({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { busy, importPhase, openImport, doExportZip } = useFileOperations();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <header className={className}>
      {/* 高さは罫線込みで 48px（左のエディタパネル見出しと揃える）。
          狭いメイン幅ではボタン群が 2 行目に折り返す（横にはみ出さない）。 */}
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-5 py-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="cursor-pointer rounded text-left text-base font-semibold text-fg hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title={t('header.aboutTooltip')}
          >
            {t('app.title')}
            {/* `__APP_VERSION__` は素の semver（package.json 由来）。`v` は表示側で付ける。 */}
            <span className="ml-2 text-xs font-normal text-fg-subtle">
              {`v${__APP_VERSION__}`}
            </span>
          </button>

          <a
            href={LATEST_RELEASE_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={t('header.releasesTooltip')}
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-fg-muted hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {t('header.releases')}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-3.5 w-3.5"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 6H18v4.5M17.25 6.75L10.5 13.5M18 14.25V18a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 18V7.5A1.5 1.5 0 016 6h3.75"
              />
            </svg>
          </a>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={openImport}
          >
            {importPhase === 'loading-zip'
              ? t('header.importing')
              : t('header.import')}
          </Button>
          <Button size="sm" disabled={busy} onClick={doExportZip}>
            {busy && importPhase === 'idle'
              ? t('header.exporting')
              : t('header.export')}
          </Button>
        </div>
      </div>

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </header>
  );
}
