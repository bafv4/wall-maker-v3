/**
 * DesktopUpdateNotice — 起動時の更新通知ダイアログ（Desktop 専用）。
 *
 * 起動時に一度だけ GitHub Releases の最新版をチェックし、新しいバージョンが
 * あれば別ウィンドウのダイアログ（`useDialogWindow`）で知らせる。
 * 更新の処理はメインウィンドウ側で行い、ダイアログには進み具合を `state` で送る。
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

import { useEffect, useMemo, useState } from 'react';
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
import type { DialogSpec, UpdateDownloadState } from './dialogs/dialogSpec';
import { useDialogWindow } from './dialogs/useDialogWindow';
import { Button, ExternalLink, toast } from './ui';

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

function toPercent(p: AppUpdateProgress): number | null {
  return p.total && p.total > 0
    ? Math.min(100, Math.round((p.received / p.total) * 100))
    : null;
}

type UpdateSpec = Extract<DialogSpec, { kind: 'update' }>;
type UpdateAction = 'apply' | 'download' | 'reveal' | 'later';

/** 更新ダイアログの本文（別ウィンドウ側で描く）。操作は `onAction` でメインへ送る。 */
export function UpdateContent({
  spec,
  download,
  autoApply,
  onAction,
}: {
  spec: UpdateSpec;
  download: UpdateDownloadState;
  autoApply: boolean;
  onAction: (name: UpdateAction) => void;
}) {
  const { t } = useTranslation();
  const size = spec.assetSize != null ? ` (${formatBytes(spec.assetSize)})` : '';
  const busy = download.kind === 'applying' || download.kind === 'restarting';

  let status: string | null = null;
  if (download.kind === 'applying')
    status =
      download.percent === null
        ? t('update.applying')
        : t('update.applyingPercent', { percent: download.percent });
  else if (download.kind === 'restarting') status = t('update.restarting');
  else if (download.kind === 'applied') status = t('update.applied');
  else if (download.kind === 'downloading')
    status =
      download.percent === null
        ? t('update.downloading')
        : t('update.downloadingPercent', { percent: download.percent });
  else if (download.kind === 'done')
    status = t('update.savedTo', { path: download.path });

  return (
    <div className="space-y-4 text-sm">
      <p className="font-medium text-fg">
        {t('update.available', {
          version: spec.version,
          current: spec.currentVersion,
        })}
      </p>
      {status && (
        <p className="break-all text-fg-muted" role="status">
          {status}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ExternalLink href={spec.releaseUrl} className="mr-auto text-sm">
          {t('update.releasePage')}
        </ExternalLink>
        {download.kind === 'done' && (
          <Button size="sm" variant="outline" onClick={() => onAction('reveal')}>
            {t('update.showInFolder')}
          </Button>
        )}
        {/* 適用中に閉じると、見えないまま再起動が走るので閉じさせない */}
        {!busy && (
          <Button size="sm" variant="outline" onClick={() => onAction('later')}>
            {t('common.close')}
          </Button>
        )}
        {download.kind === 'idle' && autoApply && (
          <Button size="sm" onClick={() => onAction('apply')}>
            {t('update.applyAndRestart')}
            {size}
          </Button>
        )}
        {download.kind === 'idle' && !autoApply && spec.assetName && (
          <Button size="sm" onClick={() => onAction('download')}>
            {t('update.download', { name: spec.assetName })}
            {size}
          </Button>
        )}
      </div>
    </div>
  );
}

export function DesktopUpdateNotice() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [download, setDownload] = useState<UpdateDownloadState>({ kind: 'idle' });
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

  const startDownload = () => {
    if (!info?.assetUrl || !info.assetName) return;
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

  const autoApply = !!info?.canAutoApply && !applyFailed;
  const busy = download.kind === 'applying' || download.kind === 'restarting';
  const update = useMemo(() => ({ download, autoApply }), [download, autoApply]);

  useDialogWindow({
    open: !!info && !dismissed,
    spec: {
      kind: 'update',
      title: t('update.title'),
      width: 480,
      version: info?.version ?? '',
      currentVersion: info?.currentVersion ?? '',
      releaseUrl: info?.releaseUrl ?? '',
      assetName: info?.assetUrl ? (info.assetName ?? null) : null,
      assetSize: info?.assetSize ?? null,
    },
    state: { busy, update },
    onMessage: (m) => {
      if (m.type === 'dismiss' || (m.type === 'action' && m.name === 'later')) {
        // 適用中は × / Esc も無視する
        if (!busy) setDismissed(true);
      } else if (m.type === 'action') {
        if (m.name === 'apply') startApply();
        else if (m.name === 'download') startDownload();
        else if (m.name === 'reveal' && download.kind === 'done')
          void revealAppUpdateFile(download.path).catch((e: unknown) => {
            console.warn('reveal failed', e);
          });
      }
    },
  });

  return null;
}
