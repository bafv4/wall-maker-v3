/**
 * FileEditor — Desktop 用の「ファイル」タブ。
 *
 * Web では AppHeader の右上ボタン群が同じ役割を担う。Desktop ではヘッダーを
 * 表示しないため、Import / Save / Export / Reset をこのタブに集約する。
 *
 * セクション:
 *  - インポート   : `.zip` または展開済みフォルダから読込
 *  - 保存         : フォルダ形式で「名前を付けて保存」／「上書き保存」
 *  - エクスポート : `.zip` ファイルとして 1 ファイル書き出し
 *  - リセット     : デフォルトに戻す
 *
 * 進行状態は `useFileOperations()` で共有しており、タブ切替で消えない。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileOperations } from '../hooks/useFileOperations';
import { AboutModal } from './AboutModal';
import { Button } from './ui';

interface ActionRowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function ActionRow({ title, description, children }: ActionRowProps) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-panel p-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
          {description}
        </p>
      </div>
      <div className="pt-1">{children}</div>
    </section>
  );
}

/**
 * 現在の保存先（上書き対象）バナー。
 * 通常の ActionRow カード（slate）とは別スタイルで、タブ最上部に常駐する。
 * フォルダから開いた／フォルダで保存した直後のみ（`path != null`）表示する。
 */
function SaveTargetBanner({ path }: { path: string | null }) {
  const { t } = useTranslation();
  if (!path) return null;
  return (
    <div className="rounded-lg border border-blue-200 border-l-4 border-l-blue-500 bg-accent-soft px-4 py-2.5 dark:border-blue-900 dark:border-l-blue-500">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-soft-fg">
        {t('fileEditor.save.currentTargetLabel')}
      </div>
      <code className="mt-0.5 block break-all text-xs text-fg">
        {path}
      </code>
    </div>
  );
}

export function FileEditor() {
  const { t } = useTranslation();
  const {
    busy,
    importPhase,
    openZipImport,
    openFolderImport,
    doExportZip,
    doSaveAsFolder,
    doSaveOverwrite,
    canOverwrite,
    sourceFolder,
    doReset,
  } = useFileOperations();

  const importing = importPhase === 'loading-zip';
  const otherBusy = busy && importPhase === 'idle';

  return (
    <div className="space-y-4">
      <SaveTargetBanner path={sourceFolder} />

      <ActionRow
        title={t('fileEditor.import.title')}
        description={t('fileEditor.import.description')}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void openZipImport()}
          >
            {importing ? t('fileEditor.import.loading') : t('fileEditor.import.openZip')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void openFolderImport()}
          >
            {importing ? t('fileEditor.import.loading') : t('fileEditor.import.openFolder')}
          </Button>
        </div>
      </ActionRow>

      <ActionRow
        title={t('fileEditor.save.title')}
        description={t('fileEditor.save.description')}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={otherBusy}
            onClick={() => void doSaveAsFolder()}
          >
            {otherBusy ? t('fileEditor.save.processing') : t('fileEditor.save.saveAs')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={otherBusy || !canOverwrite}
            onClick={() => void doSaveOverwrite()}
          >
            {t('fileEditor.save.overwrite')}
          </Button>
        </div>
      </ActionRow>

      <ActionRow
        title={t('fileEditor.export.title')}
        description={t('fileEditor.export.description')}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={otherBusy}
          onClick={() => void doExportZip()}
        >
          {otherBusy ? t('fileEditor.export.processing') : t('fileEditor.export.button')}
        </Button>
      </ActionRow>

      <ActionRow
        title={t('fileEditor.reset.title')}
        description={t('fileEditor.reset.description')}
      >
        <Button size="sm" variant="danger-outline" onClick={doReset}>
          {t('fileEditor.reset.button')}
        </Button>
      </ActionRow>

      <AboutSection />
    </div>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionRow
        title={t('fileEditor.about.title')}
        description={t('fileEditor.about.description')}
      >
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t('fileEditor.about.button')}
        </Button>
      </ActionRow>
      <AboutModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
