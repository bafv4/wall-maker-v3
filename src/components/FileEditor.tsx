/**
 * FileEditor — レール先頭の「ファイル」タブ（Web / Desktop 共通）。
 *
 * パックの出し入れと、書き出し内容に関わる設定をここに集約する。
 *
 * セクション:
 *  - インポート   : Web=`.zip`（hidden `<input>`）/ Desktop=`.zip` またはフォルダ（Tauri dialog）
 *  - 保存         : Desktop のみ。フォルダ形式で「名前を付けて保存」／「上書き保存」
 *  - エクスポート : `.zip` 1 ファイル（Web=ダウンロード / Desktop=保存ダイアログ）
 *  - 背景の編集データを同梱する : 書き出し（zip / フォルダ）に wall-maker/ を含めるか
 *
 * リセットは書き出しボタンの並びで押し間違えないよう、一覧から離して最後に置く。
 * 内容がパネルに収まるときはパネルの下端に寄せ、スクロールするときはスクロールの末尾に来る
 * （ルートを `flex-1` の縦並びにし、リセットを `mt-auto` で押し下げる）。
 *
 * 進行状態は `useFileOperations()` で共有しており、タブ切替で消えない。
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '../adapters';
import { useFileOperations } from '../hooks/useFileOperations';
import { useWallStore } from '../store/useWallStore';
import { Button, Switch } from './ui';

interface ActionRowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function ActionRow({ title, description, children }: ActionRowProps) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-panel p-4">
      <div>
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
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
    <div className="rounded-lg border border-border border-l-4 border-l-primary bg-accent-soft px-4 py-2.5">
      <div className="text-xs font-semibold text-accent-soft-fg">
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
  const desktop = isTauri();
  const {
    busy,
    importPhase,
    openImport,
    openZipImport,
    openFolderImport,
    doExportZip,
    doSaveAsFolder,
    doSaveOverwrite,
    canOverwrite,
    sourceFolder,
  } = useFileOperations();

  const importing = importPhase === 'loading-zip';
  // ボタンの活性は busy で一律に制御。otherBusy はラベルの「処理中」表示のみに使う。
  const otherBusy = busy && importPhase === 'idle';

  return (
    <div className="flex flex-1 flex-col">
      <div className="space-y-4">
        <SaveTargetBanner path={sourceFolder} />

        <ActionRow
          title={t('fileEditor.import.title')}
          description={t(
            desktop
              ? 'fileEditor.import.description'
              : 'fileEditor.import.descriptionWeb',
          )}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => (desktop ? void openZipImport() : openImport())}
            >
              {importing ? t('fileEditor.import.loading') : t('fileEditor.import.openZip')}
            </Button>
            {desktop && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void openFolderImport()}
              >
                {importing ? t('fileEditor.import.loading') : t('fileEditor.import.openFolder')}
              </Button>
            )}
          </div>
        </ActionRow>

        {desktop && (
          <ActionRow
            title={t('fileEditor.save.title')}
            description={t('fileEditor.save.description')}
          >
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void doSaveAsFolder()}
              >
                {otherBusy ? t('fileEditor.save.processing') : t('fileEditor.save.saveAs')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canOverwrite}
                onClick={() => void doSaveOverwrite()}
              >
                {t('fileEditor.save.overwrite')}
              </Button>
            </div>
          </ActionRow>
        )}

        <ActionRow
          title={t('fileEditor.export.title')}
          description={t(
            desktop
              ? 'fileEditor.export.description'
              : 'fileEditor.export.descriptionWeb',
          )}
        >
          {/* Web では唯一の出力手段なので主ボタン。Desktop は保存（フォルダ）が主 */}
          <Button
            size="sm"
            variant={desktop ? 'outline' : undefined}
            disabled={busy}
            onClick={() => void doExportZip()}
          >
            {otherBusy
              ? t('fileEditor.export.processing')
              : t(desktop ? 'fileEditor.export.button' : 'fileEditor.export.buttonWeb')}
          </Button>
        </ActionRow>

        <EmbedEditorDataSection />

      </div>

      <div className="mt-auto pt-4">
        <FileResetBar />
      </div>
    </div>
  );
}

/** 書き出しに背景の編集データ（wall-maker/）を含めるか。zip / フォルダの両方に効く。 */
function EmbedEditorDataSection() {
  const { t } = useTranslation();
  const id = useId();
  const embed = useWallStore((s) => s.wall.packInfo.embedEditorData ?? false);
  const setPackInfo = useWallStore((s) => s.setPackInfo);
  return (
    <section className="space-y-1.5 rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold text-fg">
          {t('fileEditor.embed.label')}
        </label>
        <Switch
          id={id}
          checked={embed}
          onChange={(b) => setPackInfo({ embedEditorData: b })}
          aria-describedby={`${id}-desc`}
        />
      </div>
      <p id={`${id}-desc`} className="text-xs leading-relaxed text-fg-muted">
        {t('fileEditor.embed.hint')}
      </p>
    </section>
  );
}

/**
 * リセット。パネルの左右・下の余白まで広げ、区切り線で一覧と分ける。
 * Import/Export と同じく busy 中は押せなくする。エクスポート中にリセットされると
 * worker が古い state のままパックを作り切り、空のエディタに対して成功トーストが出てしまう。
 */
function FileResetBar() {
  const { t } = useTranslation();
  const { busy, doReset } = useFileOperations();
  const desktop = isTauri();
  return (
    <div className="-mx-4 -mb-4 flex items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-xs leading-relaxed text-fg-muted">
        {t(
          desktop
            ? 'fileEditor.reset.description'
            : 'fileEditor.reset.descriptionWeb',
        )}
      </p>
      <Button
        size="sm"
        variant="danger-outline"
        disabled={busy}
        onClick={doReset}
        className="flex-shrink-0"
      >
        {t('fileEditor.reset.button')}
      </Button>
    </div>
  );
}
