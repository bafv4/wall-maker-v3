/**
 * CropModal — 画像レイヤのソース矩形（crop）をビジュアルで決める。
 *
 *  - 画像を最大 600px 内に表示。
 *  - 透過した crop 矩形を 8 ハンドル＋本体ドラッグで操作。
 *  - 全座標は画像の自然 px に変換し floor で整数化して適用。
 *  - 数値入力欄でも編集可能。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AreaCell, ImageLayer } from '../core/state';
import { Button, Modal } from './ui';
import { cn } from './ui/cn';
import type { Handle } from './snap';

const DISPLAY_MAX = 600;
const MIN_SIZE = 1;
const HANDLE_LIST: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const handleClass: Record<Handle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  s: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

type DragMode = { type: 'move' } | { type: 'resize'; handle: Handle };

interface DragState {
  mode: DragMode;
  startClientX: number;
  startClientY: number;
  startCrop: AreaCell;
  pxToImage: number; // = imageNatural / displayed
}

function applyResize(
  start: AreaCell,
  handle: Handle,
  dx: number,
  dy: number,
): AreaCell {
  let { x, y, width, height } = start;
  switch (handle) {
    case 'nw': x += dx; y += dy; width -= dx; height -= dy; break;
    case 'n':  y += dy; height -= dy; break;
    case 'ne': y += dy; width += dx; height -= dy; break;
    case 'e':  width += dx; break;
    case 'se': width += dx; height += dy; break;
    case 's':  height += dy; break;
    case 'sw': x += dx; width -= dx; height += dy; break;
    case 'w':  x += dx; width -= dx; break;
  }
  if (width < MIN_SIZE) {
    if (handle === 'nw' || handle === 'w' || handle === 'sw') x = start.x + start.width - MIN_SIZE;
    width = MIN_SIZE;
  }
  if (height < MIN_SIZE) {
    if (handle === 'nw' || handle === 'n' || handle === 'ne') y = start.y + start.height - MIN_SIZE;
    height = MIN_SIZE;
  }
  return { x, y, width, height };
}

function clampToImage(c: AreaCell, w: number, h: number): AreaCell {
  const x = Math.max(0, Math.min(c.x, w - 1));
  const y = Math.max(0, Math.min(c.y, h - 1));
  const width = Math.max(1, Math.min(c.width, w - x));
  const height = Math.max(1, Math.min(c.height, h - y));
  return { x, y, width, height };
}

export interface CropModalProps {
  layer: ImageLayer;
  onClose: () => void;
  onApply: (crop: AreaCell) => void;
}

export function CropModal({ layer, onClose, onApply }: CropModalProps) {
  const { t } = useTranslation();
  const imageUrl = useMemo(() => {
    if (layer.source.kind !== 'inline') return null;
    return URL.createObjectURL(
      // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
      new Blob([layer.source.bytes as Uint8Array<ArrayBuffer>], {
        type: layer.source.mimeType ?? 'image/png',
      }),
    );
  }, [layer.source]);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // 自然サイズ
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // 表示サイズ
  const [displayed, setDisplayed] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  // crop 状態（画像の自然 px）
  const [crop, setCrop] = useState<AreaCell>(() =>
    layer.crop ?? { x: 0, y: 0, width: 1, height: 1 },
  );

  // 画像ロード時に natural / 初期 crop を計算
  const handleImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    if (!layer.crop) {
      setCrop({ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight });
    }
  };

  // 表示サイズの追従
  useLayoutEffect(() => {
    if (!natural) return;
    const maxAspect = natural.w / natural.h;
    let w: number, h: number;
    if (maxAspect >= 1) {
      w = Math.min(DISPLAY_MAX, natural.w);
      h = w / maxAspect;
    } else {
      h = Math.min(DISPLAY_MAX, natural.h);
      w = h * maxAspect;
    }
    setDisplayed({ w, h });
  }, [natural]);

  // crop を表示座標に
  const display = useMemo(() => {
    if (!natural) return { x: 0, y: 0, width: 0, height: 0 };
    const sx = displayed.w / natural.w;
    const sy = displayed.h / natural.h;
    return {
      x: crop.x * sx,
      y: crop.y * sy,
      width: crop.width * sx,
      height: crop.height * sy,
    };
  }, [crop, natural, displayed]);

  // ---- pointer 操作 ----

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => {
      if (e.button !== 0 || !natural || displayed.w === 0) return;
      dragRef.current = {
        mode,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCrop: crop,
        pxToImage: natural.w / displayed.w,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [crop, natural, displayed],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !natural) return;
      const dxImage = (e.clientX - drag.startClientX) * drag.pxToImage;
      const dyImage = (e.clientY - drag.startClientY) * drag.pxToImage;
      let next: AreaCell;
      if (drag.mode.type === 'move') {
        next = {
          ...drag.startCrop,
          x: drag.startCrop.x + dxImage,
          y: drag.startCrop.y + dyImage,
        };
      } else {
        next = applyResize(drag.startCrop, drag.mode.handle, dxImage, dyImage);
      }
      setCrop(clampToImage(next, natural.w, natural.h));
    },
    [natural],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  // ---- 数値入力 ----
  const handleField =
    (field: 'x' | 'y' | 'width' | 'height') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!natural) return;
      const v = Math.floor(Number(e.target.value) || 0);
      const next = { ...crop, [field]: v };
      setCrop(clampToImage(next, natural.w, natural.h));
    };

  const handleReset = () => {
    if (!natural) return;
    setCrop({ x: 0, y: 0, width: natural.w, height: natural.h });
  };

  const handleApply = () => {
    if (!natural) return;
    onApply({
      x: Math.floor(crop.x),
      y: Math.floor(crop.y),
      width: Math.floor(crop.width),
      height: Math.floor(crop.height),
    });
  };

  return (
    <Modal open onClose={onClose} title={t('cropModal.title')} className="max-w-3xl">
      {!imageUrl ? (
        <p className="text-sm text-fg-muted">{t('cropModal.imageNotLoaded')}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-center bg-muted p-3">
            <div
              ref={overlayRef}
              className="relative inline-block select-none"
              style={{ width: displayed.w, height: displayed.h }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt=""
                onLoad={handleImgLoad}
                draggable={false}
                style={{
                  width: displayed.w || 'auto',
                  height: displayed.h || 'auto',
                  display: 'block',
                  userSelect: 'none',
                }}
              />
              {natural && displayed.w > 0 && (
                <>
                  {/* 暗い被せ（crop 外側） */}
                  <div className="pointer-events-none absolute inset-0 bg-black/40" />
                  <div
                    className="absolute"
                    style={{
                      left: display.x,
                      top: display.y,
                      width: display.width,
                      height: display.height,
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
                      cursor: 'move',
                      touchAction: 'none',
                    }}
                    onPointerDown={(e) => onPointerDown(e, { type: 'move' })}
                  >
                    <div className="absolute inset-0 border-2 border-violet-500" />
                    {HANDLE_LIST.map((h) => (
                      <div
                        key={h}
                        className={cn(
                          'absolute h-3 w-3 rounded-sm border-2 border-violet-500 bg-surface',
                          handleClass[h],
                        )}
                        style={{ touchAction: 'none' }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onPointerDown(e, { type: 'resize', handle: h });
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <label className="text-xs text-fg-muted">
              {t('areaEditor.x')}
              <input
                type="number"
                value={Math.floor(crop.x)}
                onChange={handleField('x')}
                className="mt-0.5 h-8 w-full rounded border border-border-strong px-2 text-sm"
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t('areaEditor.y')}
              <input
                type="number"
                value={Math.floor(crop.y)}
                onChange={handleField('y')}
                className="mt-0.5 h-8 w-full rounded border border-border-strong px-2 text-sm"
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t('areaEditor.width')}
              <input
                type="number"
                min={1}
                value={Math.floor(crop.width)}
                onChange={handleField('width')}
                className="mt-0.5 h-8 w-full rounded border border-border-strong px-2 text-sm"
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t('areaEditor.height')}
              <input
                type="number"
                min={1}
                value={Math.floor(crop.height)}
                onChange={handleField('height')}
                className="mt-0.5 h-8 w-full rounded border border-border-strong px-2 text-sm"
              />
            </label>
          </div>

          {natural && (
            <p className="text-[11px] text-fg-subtle">
              {t('cropModal.imageSize', { width: natural.w, height: natural.h })}
            </p>
          )}

          <div className="flex justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={handleReset}>
              {t('cropModal.reset')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleApply}>
                {t('common.apply')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
