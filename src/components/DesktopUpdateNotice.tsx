/**
 * DesktopUpdateNotice — 起動時の更新通知バナー（Desktop 専用）。
 *
 * 起動時に一度だけ GitHub Releases の最新版をチェックし、新しいバージョンが
 * あればタブの上に横断バナーを出す。「ダウンロード」で配布形態に合うアセットを
 * **実行ファイルと同じフォルダ**へ保存する（適用はユーザー自身。自動更新はしない）。
 *
 *  - チェック結果・却下状態はモジュールレベルに持つ。タブ切替やアンマウントで
 *    再フェッチ・再通知しないため（チェックはアプリ起動につき 1 回）。
 *  - チェック失敗は console.warn のみ（オフライン起動を邪魔しない）。
 *  - 対応アセットが見つからないリリース（命名変更など）はダウンロードボタンを
 *    出さず、リリースページへのリンクだけ出す。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  checkAppUpdate,
  downloadAppUpdate,
  openExternalUrl,
  revealAppUpdateFile,
  type AppUpdateInfo,
} from '../adapters';
import { errMsg } from '../core/errors';
import { Button, toast } from './ui';

// アプリ起動につき 1 回だけチェックする（コンポーネントの再マウントでは再実行しない）
let checkPromise: Promise<AppUpdateInfo | null> | null = null;
let dismissedVersion: string | null = null;
let toastShown = false;

function ensureCheck(current: string): Promise<AppUpdateInfo | null> {
  checkPromise ??= checkAppUpdate(current).catch((e: unknown) => {
    // オフラインや API レート制限で普通に失敗しうる。起動を妨げない。
    console.warn('update check failed', e);
    return null;
  });
  return checkPromise;
}

type DownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'done'; path: string };

export function DesktopUpdateNotice() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let canceled = false;
    void ensureCheck(__APP_VERSION__).then((result) => {
      if (canceled || !result) return;
      setInfo(result);
      if (result.version === dismissedVersion) setDismissed(true);
      if (!toastShown) {
        toastShown = true;
        toast.info(t('update.toastAvailable', { version: result.version }));
      }
    });
    return () => {
      canceled = true;
    };
  }, [t]);

  if (!info || dismissed) return null;

  const startDownload = () => {
    if (!info.assetUrl || !info.assetName) return;
    setDownload({ kind: 'downloading', percent: null });
    downloadAppUpdate(info.assetUrl, info.assetName, (p) => {
      setDownload({
        kind: 'downloading',
        percent:
          p.total && p.total > 0
            ? Math.min(100, Math.round((p.received / p.total) * 100))
            : null,
      });
    })
      .then((path) => {
        setDownload({ kind: 'done', path });
        toast.success(t('update.downloaded', { path }));
      })
      .catch((e: unknown) => {
        setDownload({ kind: 'idle' });
        toast.error(t('update.downloadFailed', { error: errMsg(e) }));
      });
  };

  const dismiss = () => {
    dismissedVersion = info.version;
    setDismissed(true);
  };

  const sizeMb =
    info.assetSize != null
      ? ` (${(info.assetSize / 1024 / 1024).toFixed(1)} MB)`
      : '';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-accent-soft px-4 py-2 text-sm text-fg">
      <span className="font-medium">
        {t('update.available', {
          version: info.version,
          current: __APP_VERSION__,
        })}
      </span>

      {download.kind === 'idle' && info.assetUrl && info.assetName && (
        <Button size="sm" onClick={startDownload}>
          {t('update.download', { name: info.assetName })}
          {sizeMb}
        </Button>
      )}
      {download.kind === 'downloading' && (
        <span className="text-fg-muted">
          {download.percent === null
            ? t('update.downloading')
            : t('update.downloadingPercent', { percent: download.percent })}
        </span>
      )}
      {download.kind === 'done' && (
        <>
          <span className="text-fg-muted">
            {t('update.savedTo', { path: download.path })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void revealAppUpdateFile(download.path).catch((e: unknown) => {
                console.warn('reveal failed', e);
              });
            }}
          >
            {t('update.showInFolder')}
          </Button>
        </>
      )}

      {/* Tauri webview では target=_blank が環境依存で無反応のため opener 経由で開く */}
      <a
        href={info.releaseUrl}
        onClick={(e) => {
          e.preventDefault();
          void openExternalUrl(info.releaseUrl).catch((err: unknown) => {
            console.warn('open release page failed', err);
          });
        }}
        className="text-blue-600 underline hover:text-blue-800"
      >
        {t('update.releasePage')}
      </a>

      <button
        type="button"
        onClick={dismiss}
        className="ml-auto cursor-pointer rounded px-1.5 text-fg-subtle hover:text-fg"
        aria-label={t('common.close')}
        title={t('common.close')}
      >
        ×
      </button>
    </div>
  );
}
