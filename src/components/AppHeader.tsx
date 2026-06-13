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
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileOperations } from '../hooks/useFileOperations';
import { AboutModal } from './AboutModal';
import { Button } from './ui';

export function AppHeader() {
  const { t } = useTranslation();
  const { busy, importPhase, openImport, doExportZip, doReset } =
    useFileOperations();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <header className="flex-shrink-0 border-b border-border bg-surface">
      <div className="mx-auto flex h-16 max-w-[1920px] items-center justify-between gap-4 px-5">
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="cursor-pointer rounded text-left text-lg font-semibold text-fg hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          title={t('header.aboutTooltip')}
        >
          {t('app.title')}
          <span className="ml-2 text-xs font-normal text-fg-subtle">
            {__APP_VERSION__}
          </span>
        </button>

        <div className="flex items-center gap-3">
          <Button variant="danger-outline" size="sm" onClick={doReset}>
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
