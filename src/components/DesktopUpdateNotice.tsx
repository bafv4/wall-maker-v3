/**
 * DesktopUpdateNotice — 起動時の更新通知バナー（Desktop 専用）。
 *
 * 起動時に一度だけ GitHub Releases の最新版をチェックし、新しいバージョンが
 * あればタブの上に横断バナーを出す。
 *  - Windows ポータブル版（`canAutoApply`）: 「更新して再起動」で exe をダウンロード・
 *    SHA-256 検証・差し替えし、永続化を書き切ってから新しい exe で再起動する。
 *    失敗したら通常のダウンロードボタンに戻す。
 *  - それ以外: 「ダウンロード」で配布形態に合うアセットを**実行ファイルと同じフォルダ**へ
 *    保存する（適用はユーザー自身）。
 * どちらもユーザーが押したときだけ動く（バックグラウンドでの自動適用はしない）。
 *
 *  - コンポーネントは App 直下（タブの外）に 1 度だけマウントされ、アンマウント
 *    されない。checkPromise だけモジュールレベルに置くのは StrictMode の
 *    二重 effect と HMR での再フェッチを防ぐため。
 *  - チェック失敗は console.warn のみ（オフライン起動を邪魔しない）。
 *  - 対応アセットが見つからないリリース（命名変更など）はダウンロードボタンを
 *    出さず、リリースページへのリンクだけ出す。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyAppUpdate,
  checkAppUpdate,
  downloadAppUpdate,
  relaunchAfterAppUpdate,
  revealAppUpdateFile,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from '../adapters';
import { errMsg } from '../core/errors';
import { formatBytes } from '../core/format';
import { flushPersistedWrites } from '../store/persistAdapter';
import { Button, ExternalLink, toast } from './ui';
import { CloseIcon } from './ui/icons';

// アプリ起動につき 1 回だけチェックする（StrictMode の二重 effect / HMR 対策）
let checkPromise: Promise<AppUpdateInfo | null> | null = null;

function ensureCheck(): Promise<AppUpdateInfo | null> {
  checkPromise ??= checkAppUpdate().catch((e: unknown) => {
    // オフラインや API レート制限で普通に失敗しうる。起動を妨げない。
    console.warn('update check failed', e);
    return null;
  });
  return checkPromise;
}

type DownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'done'; path: string }
  /** ワンクリック更新: ダウンロード〜差し替え中 */
  | { kind: 'applying'; percent: number | null }
  /** 差し替え済み。永続化を書き切って再起動中 */
  | { kind: 'restarting' }
  /** 差し替え済みだが再起動に失敗（手動で起動し直せば新版になる） */
  | { kind: 'applied' };

function toPercent(p: AppUpdateProgress): number | null {
  return p.total && p.total > 0
    ? Math.min(100, Math.round((p.received / p.total) * 100))
    : null;
}

export function DesktopUpdateNotice() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  /** ワンクリック更新に一度失敗したら、以後は通常のダウンロードに切り替える */
  const [applyFailed, setApplyFailed] = useState(false);

  useEffect(() => {
    let canceled = false;
    void ensureCheck().then((result) => {
      if (!canceled && result) setInfo(result);
    });
    return () => {
      canceled = true;
    };
  }, []);

  if (!info || dismissed) return null;

  const startDownload = () => {
    if (!info.assetUrl || !info.assetName) return;
    setDownload({ kind: 'downloading', percent: null });
    downloadAppUpdate(info.assetUrl, info.assetName, (p) => {
      setDownload({ kind: 'downloading', percent: toPercent(p) });
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

  const startApply = () => {
    setDownload({ kind: 'applying', percent: null });
    applyAppUpdate((p) => {
      setDownload({ kind: 'applying', percent: toPercent(p) });
    }).then(
      async () => {
        setDownload({ kind: 'restarting' });
        try {
          // 終了で保留中の編集内容を失わないよう、書き切ってから再起動する
          await flushPersistedWrites();
          await relaunchAfterAppUpdate();
        } catch (e: unknown) {
          setDownload({ kind: 'applied' });
          toast.error(t('update.restartFailed', { error: errMsg(e) }));
        }
      },
      (e: unknown) => {
        setApplyFailed(true);
        setDownload({ kind: 'idle' });
        toast.error(t('update.applyFailed', { error: errMsg(e) }));
      },
    );
  };

  const autoApply = info.canAutoApply && !applyFailed;
  const busy = download.kind === 'applying' || download.kind === 'restarting';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-accent-soft px-4 py-2 text-sm text-fg">
      <span className="font-medium">
        {t('update.available', {
          version: info.version,
          current: info.currentVersion,
        })}
      </span>

      {download.kind === 'idle' && autoApply && (
        <Button size="sm" onClick={startApply}>
          {t('update.applyAndRestart')}
          {info.assetSize != null && ` (${formatBytes(info.assetSize)})`}
        </Button>
      )}
      {download.kind === 'applying' && (
        <span className="text-fg-muted">
          {download.percent === null
            ? t('update.applying')
            : t('update.applyingPercent', { percent: download.percent })}
        </span>
      )}
      {download.kind === 'restarting' && (
        <span className="text-fg-muted">{t('update.restarting')}</span>
      )}
      {download.kind === 'applied' && (
        <span className="text-fg-muted">{t('update.applied')}</span>
      )}
      {download.kind === 'idle' && !autoApply && info.assetUrl && info.assetName && (
        <Button size="sm" onClick={startDownload}>
          {t('update.download', { name: info.assetName })}
          {info.assetSize != null && ` (${formatBytes(info.assetSize)})`}
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

      <ExternalLink href={info.releaseUrl}>
        {t('update.releasePage')}
      </ExternalLink>

      {/* 適用中に閉じると、見えないまま再起動が走るので閉じさせない */}
      {!busy && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto cursor-pointer rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg"
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
