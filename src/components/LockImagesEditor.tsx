/**
 * LockImagesEditor — lock 画像（lock.png + lock-N.png）の管理。
 *
 * 仕様: REWRITE_SPEC.md 第6.5章。
 *  - 出力順: **1 枚目=`lock.png`、以降 `lock-1.png`、`lock-2.png`、...**。
 *  - SeedQueue は `lock.png` が無いと以降を一切読まない → UI で 1 枚目の特別性を可視化。
 *  - `enabled=false`: 透明 128x128 を `lock.png` として出力（buildPack 側で生成）。
 *  - `enabled=true` で images が空: MOD 既定の lock.png にフォールバック（何も出力しない）。
 *  - サイズ自由（リサイズしない）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errMsg } from '../core/errors';
import type { LockImage } from '../core/state';
import { useWallStore } from '../store/useWallStore';
import { Button, Switch, toast } from './ui';
import { cn } from './ui/cn';

interface RowProps {
  image: LockImage;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function LockImageRow({ image, index, total, onMoveUp, onMoveDown, onDelete }: RowProps) {
  const { t } = useTranslation();
  const previewUrl = useMemo(() => {
    if (image.source.kind !== 'inline') return null;
    return URL.createObjectURL(
      new Blob([image.source.bytes], {
        type: image.source.mimeType ?? 'image/png',
      }),
    );
  }, [image.source]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const filename = index === 0 ? 'lock.png' : `lock-${index}.png`;
  const sizeKb =
    image.source.kind === 'inline'
      ? `${(image.source.bytes.byteLength / 1024).toFixed(1)} KB`
      : 'ref';

  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-md border bg-surface p-2',
        index === 0 ? 'border-blue-300 bg-accent-soft' : 'border-border',
      )}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="h-12 w-12 rounded border border-border-strong bg-surface object-contain"
        />
      ) : (
        <div className="h-12 w-12 rounded border border-dashed border-border-strong" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
            {filename}
          </code>
          {index === 0 && (
            <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
              {t('lock.required')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
          {image.originalFileName ?? t('lock.noName')} · {sizeKb}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5">
        <button
          type="button"
          disabled={index === 0}
          onClick={onMoveUp}
          className="h-6 w-6 rounded text-xs text-fg-subtle hover:bg-muted disabled:opacity-30"
          title={t('lock.moveUp')}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={index === total - 1}
          onClick={onMoveDown}
          className="h-6 w-6 rounded text-xs text-fg-subtle hover:bg-muted disabled:opacity-30"
          title={t('lock.moveDown')}
        >
          ↓
        </button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          {t('lock.delete')}
        </Button>
      </div>
    </li>
  );
}

export function LockImagesEditor() {
  const { t } = useTranslation();
  const lockImages = useWallStore((s) => s.wall.lockImages);
  const setLockEnabled = useWallStore((s) => s.setLockEnabled);
  const addLockImage = useWallStore((s) => s.addLockImage);
  const removeLockImage = useWallStore((s) => s.removeLockImage);
  const reorderLockImages = useWallStore((s) => s.reorderLockImages);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickingNow, setPickingNow] = useState(false);

  const handleFiles = async (files: FileList) => {
    setPickingNow(true);
    try {
      let added = 0;
      for (const file of Array.from(files)) {
        if (!/\.(png|jpe?g)$/i.test(file.name) && !/^image\//.test(file.type)) {
          toast.error(t('lock.toast.notImage', { filename: file.name }));
          continue;
        }
        const buf = await file.arrayBuffer();
        addLockImage({
          id: crypto.randomUUID(),
          source: {
            kind: 'inline',
            bytes: new Uint8Array(buf),
            mimeType: file.type || 'image/png',
          },
          originalFileName: file.name,
        });
        added++;
      }
      if (added > 0) toast.success(t('lock.toast.addedCount', { count: added }));
    } catch (e) {
      toast.error(t('lock.toast.addFailed', { error: errMsg(e) }));
    } finally {
      setPickingNow(false);
    }
  };

  const moveUp = (i: number) => {
    if (i === 0) return;
    const ids = lockImages.images.map((x) => x.id);
    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    reorderLockImages(ids);
  };
  const moveDown = (i: number) => {
    if (i === lockImages.images.length - 1) return;
    const ids = lockImages.images.map((x) => x.id);
    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
    reorderLockImages(ids);
  };

  const statusNote = !lockImages.enabled
    ? t('lock.status.disabled')
    : lockImages.images.length === 0
      ? t('lock.status.emptyEnabled')
      : t('lock.status.active', { count: lockImages.images.length });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg bg-panel p-3">
        <div>
          <span className="block text-sm font-medium text-fg">
            {t('lock.title')}
          </span>
          <span className="block text-[11px] text-fg-subtle">
            {t('lock.description')}
          </span>
        </div>
        <Switch checked={lockImages.enabled} onChange={setLockEnabled} />
      </div>

      <p
        className={cn(
          'rounded-md p-2 text-xs',
          !lockImages.enabled
            ? 'bg-muted text-fg-muted'
            : lockImages.images.length === 0
              ? 'bg-amber-50 text-amber-700'
              : 'bg-emerald-50 text-emerald-700',
        )}
      >
        {statusNote}
      </p>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void handleFiles(files);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <Button
          size="sm"
          disabled={!lockImages.enabled || pickingNow}
          onClick={() => fileInputRef.current?.click()}
        >
          {t('lock.addImage')}
        </Button>
      </div>

      {lockImages.enabled && lockImages.images.length > 0 && (
        <ul className="space-y-2">
          {lockImages.images.map((img, i) => (
            <LockImageRow
              key={img.id}
              image={img}
              index={i}
              total={lockImages.images.length}
              onMoveUp={() => moveUp(i)}
              onMoveDown={() => moveDown(i)}
              onDelete={() => removeLockImage(img.id)}
            />
          ))}
        </ul>
      )}

      <details className="text-xs text-fg-subtle">
        <summary className="cursor-pointer text-fg-muted">
          {t('lock.specMemo')}
        </summary>
        <p className="mt-2">{t('lock.specNote')}</p>
      </details>
    </div>
  );
}
