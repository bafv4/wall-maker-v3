/**
 * AppHeader — タイトル＋Import/Reset/Export（Web 用）。
 *
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

export function AppHeader() {
  const { t } = useTranslation();
  const { busy, importPhase, openImport, doExportZip, doReset } =
    useFileOperations();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <header className="flex-shrink-0 border-b border-border bg-surface">
      <div className="mx-auto flex h-16 max-w-[1920px] items-center justify-between gap-4 px-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="cursor-pointer rounded text-left text-lg font-semibold text-fg hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
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

        <div className="flex items-center gap-3">
          {/*
            Import/Export と同じく busy 中は押せなくする。エクスポート中にリセット
            されると worker が古い state のままパックを作り切り、空のエディタに対して
            成功トーストが出てしまう（Desktop 側の FileEditor と挙動を揃える）。
          */}
          <Button
            variant="danger-outline"
            size="sm"
            disabled={busy}
            onClick={doReset}
          >
            {t('header.reset')}
          </Button>
          <span className="h-6 w-px bg-border" aria-hidden="true" />
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
