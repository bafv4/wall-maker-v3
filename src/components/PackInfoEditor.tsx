/**
 * PackInfoEditor — パック名 / 説明 / アイコン / **解像度**。
 *
 * 解像度は AppHeader から移設（このタブが「パック全体の設定」に統一）。
 * アイコンは画像ドロップゾーン形式（クリック / ドラッグ&ドロップ）に刷新。
 * icon バイトは IndexedDB 永続化（Phase 3 persistAdapter 経由）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_DIMENSION, toSafeInt } from '../core/coords';
import { normalizeToPngBytes } from '../core/pngNormalize';
import { useWallStore } from '../store/useWallStore';
import { presetValueOf, useResolutionPresets } from './resolutionPresets';
import { Button, Input, Select, toast } from './ui';
import { cn } from './ui/cn';

// ---------------------------------------------------------------------------
// 解像度セクション
// ---------------------------------------------------------------------------

function ResolutionSection() {
  const { t } = useTranslation();
  const presets = useResolutionPresets();
  const resolution = useWallStore((s) => s.wall.resolution);
  const setResolution = useWallStore((s) => s.setResolution);

  const initialPreset = presetValueOf(resolution.width, resolution.height);
  const [customMode, setCustomMode] = useState(initialPreset === 'custom');
  const [customW, setCustomW] = useState(String(resolution.width));
  const [customH, setCustomH] = useState(String(resolution.height));

  // resolution が外部から変更された場合（reset 等）に input を同期
  useEffect(() => {
    setCustomW(String(resolution.width));
    setCustomH(String(resolution.height));
    // プリセットに一致する解像度に変わったらカスタムモードも解除する。
    // Select の value は customMode を優先して見るため、解除しないと
    // reset/import 後に「カスタム」表示のまま実 state（プリセット）と食い違う。
    setCustomMode(
      presetValueOf(resolution.width, resolution.height) === 'custom',
    );
  }, [resolution.width, resolution.height]);

  const handlePreset = (value: string) => {
    if (value === 'custom') {
      setCustomMode(true);
      setCustomW(String(resolution.width));
      setCustomH(String(resolution.height));
      return;
    }
    setCustomMode(false);
    const [w, h] = value.split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      setResolution({ width: w, height: h });
    }
  };

  // `<input type="number">` は "1e999" を正当な入力として返すため、素の
  // `Math.max(1, Math.floor(Number(v) || 0))` では Infinity が state に入り、
  // scaleStateForResolution 経由で layout 全体が壊れる（永続化で `x: null` として焼き付く）。
  const applyCustom = () => {
    const w = toSafeInt(customW, resolution.width, 1);
    const h = toSafeInt(customH, resolution.height, 1);
    // クランプされた場合に入力欄が古い値のまま残らないよう明示的に同期する。
    setCustomW(String(w));
    setCustomH(String(h));
    setResolution({ width: w, height: h });
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-panel p-3">
      <h3 className="text-sm font-semibold text-fg">
        {t('resolution.title')}
      </h3>
      {/*
        customMode 中は store の解像度がプリセットと一致していても `custom` を選択状態に
        保つ。store だけから導出すると、例えば 1920x1080 のまま「カスタム」を選んだ瞬間に
        表示が FHD へ戻り、入力パネルだけが開いた状態になる。
      */}
      <Select
        label={t('resolution.preset')}
        value={
          customMode ? 'custom' : presetValueOf(resolution.width, resolution.height)
        }
        onValueChange={handlePreset}
        options={presets}
      />
      {customMode && (
        <div className="space-y-2 rounded-md bg-surface p-3">
          <div className="grid grid-cols-2 gap-2">
            <Input
              label={t('resolution.width')}
              type="number"
              min={1}
              max={MAX_DIMENSION}
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
            />
            <Input
              label={t('resolution.height')}
              type="number"
              min={1}
              max={MAX_DIMENSION}
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCustomMode(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={applyCustom}>
              {t('common.apply')}
            </Button>
          </div>
        </div>
      )}
      <p className="text-[11px] text-fg-subtle">
        {t('resolution.current', {
          width: resolution.width,
          height: resolution.height,
        })}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// アイコン ドロップゾーン
// ---------------------------------------------------------------------------

interface IconDropZoneProps {
  previewUrl: string | null;
  fileName: string | null;
  onSelectFile: (file: File) => void;
  onClear: () => void;
}

function IconDropZone({
  previewUrl,
  fileName,
  onSelectFile,
  onClear,
}: IconDropZoneProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('packInfo.iconImageRequired'));
      return;
    }
    onSelectFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'group relative flex h-32 w-32 cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed bg-surface transition-colors',
          dragOver
            ? 'border-blue-500 bg-accent-soft'
            : previewUrl
              ? 'border-border-strong hover:border-blue-400'
              : 'border-border-strong hover:border-blue-400 hover:bg-muted',
        )}
        aria-label={t('packInfo.iconAria')}
      >
        {previewUrl ? (
          <>
            <img
              src={previewUrl}
              alt="icon preview"
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              {t('packInfo.iconReplaceHint')}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1 px-2 text-center text-fg-subtle">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-7 w-7"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5l4.5-4.5 3 3 6-6 4.5 4.5M3 4.5h18v15H3v-15z"
              />
            </svg>
            <span className="text-[11px] leading-tight whitespace-pre-line">
              {t('packInfo.iconDropHint')}
            </span>
          </div>
        )}
      </button>
      {previewUrl && (
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-xs text-fg-muted">
            {fileName ?? t('packInfo.iconDefaultName')}
          </span>
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('packInfo.iconClear')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export function PackInfoEditor() {
  const { t } = useTranslation();
  const packInfo = useWallStore((s) => s.wall.packInfo);
  const setPackInfo = useWallStore((s) => s.setPackInfo);

  // 元ファイル名（メモリ内のみ・保存不要）
  const [iconFileName, setIconFileName] = useState<string | null>(null);

  const iconPreviewUrl = useMemo(() => {
    const icon = packInfo.icon;
    if (!icon || icon.kind !== 'inline') return null;
    return URL.createObjectURL(
      // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
      new Blob([icon.bytes as Uint8Array<ArrayBuffer>], {
        type: icon.mimeType ?? 'image/png',
      }),
    );
  }, [packInfo.icon]);

  useEffect(() => {
    return () => {
      if (iconPreviewUrl) URL.revokeObjectURL(iconPreviewUrl);
    };
  }, [iconPreviewUrl]);

  const handleIconUpload = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      // Minecraft は PNG しか読めないため、PNG 以外はここで再エンコードする
      const png = await normalizeToPngBytes(new Uint8Array(buf));
      setPackInfo({
        icon: {
          kind: 'inline',
          bytes: png,
          mimeType: 'image/png',
        },
      });
      setIconFileName(file.name);
    } catch {
      toast.error(t('packInfo.iconImageRequired'));
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <Input
          label={t('packInfo.nameLabel')}
          value={packInfo.name}
          onChange={(e) => setPackInfo({ name: e.target.value })}
        />
        <Input
          label={t('packInfo.descriptionLabel')}
          value={packInfo.description}
          onChange={(e) => setPackInfo({ description: e.target.value })}
        />
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-fg-muted">
            {t('packInfo.iconLabel')}
          </label>
          <IconDropZone
            previewUrl={iconPreviewUrl}
            fileName={iconFileName}
            onSelectFile={(f) => void handleIconUpload(f)}
            onClear={() => {
              setPackInfo({ icon: null });
              setIconFileName(null);
            }}
          />
        </div>
      </section>

      <ResolutionSection />
    </div>
  );
}
