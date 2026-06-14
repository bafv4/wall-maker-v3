/**
 * InfoTooltip — 補足説明を出す小さな ⓘ アイコン＋独自デザインのポップオーバー。
 *
 * ツールチップは `createPortal` で body 直下に出し、トリガーの矩形から位置を計算する
 * （Select と同方針）。これによりスクロール領域や overflow:hidden の親に
 * クリップされない。配色はセマンティックトークンなので light/dark に追従する。
 *
 * 表示トリガー: hover（pointerenter/leave）＋ keyboard focus。Escape / スクロール /
 * リサイズで閉じる。ポップオーバー自体は pointer-events-none で操作を奪わない。
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface InfoTooltipProps {
  /** ツールチップ本文。 */
  text: string;
  className?: string;
}

/** ポップオーバーの固定幅（px）。中央寄せ計算とビューポートクランプに使う。 */
const TOOLTIP_WIDTH = 240;
/** トリガーとの間隔。 */
const GAP = 6;
/** ビューポート端からの最小マージン。 */
const MARGIN = 8;

interface Pos {
  left: number;
  placement: 'top' | 'bottom';
  /** placement='bottom' のとき使用。 */
  top?: number;
  /** placement='top' のとき使用（下端からの距離で上方向に伸ばす）。 */
  bottom?: number;
}

export function InfoTooltip({ text, className }: InfoTooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const id = useId();

  const compute = useCallback((): Pos | null => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const center = r.left + r.width / 2;
    const left = Math.min(
      Math.max(center - TOOLTIP_WIDTH / 2, MARGIN),
      vw - TOOLTIP_WIDTH - MARGIN,
    );
    // 上部に近いときは下に出す。それ以外は上（bottom アンカーで高さに依らず上へ伸びる）。
    const placeBelow = r.top < vh * 0.35;
    return placeBelow
      ? { placement: 'bottom', top: r.bottom + GAP, left }
      : { placement: 'top', bottom: vh - r.top + GAP, left };
  }, []);

  const show = useCallback(() => {
    setPos(compute());
    setOpen(true);
  }, [compute]);
  const hide = useCallback(() => setOpen(false), []);

  // 開いた直後に最新位置で再計測（フォントロード等のズレ対策）。
  useLayoutEffect(() => {
    if (open) setPos(compute());
  }, [open, compute]);

  // 開いている間: スクロール / リサイズ / Escape で閉じる。
  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, hide]);

  return (
    <span
      ref={triggerRef}
      role="img"
      aria-label={text}
      aria-describedby={open ? id : undefined}
      tabIndex={0}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      className={cn(
        'inline-flex h-4 w-4 flex-shrink-0 cursor-help select-none items-center justify-center rounded-full border text-[10px] font-semibold leading-none',
        'border-fg-subtle/50 text-fg-subtle',
        'hover:border-fg-subtle hover:text-fg',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        className,
      )}
    >
      i
      {open &&
        pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-[80] block rounded-md border border-border bg-surface px-3 py-2',
              'text-xs leading-relaxed text-fg-muted shadow-lg ring-1 ring-black/5 dark:ring-white/10',
            )}
            style={{
              left: pos.left,
              width: TOOLTIP_WIDTH,
              ...(pos.placement === 'bottom'
                ? { top: pos.top }
                : { bottom: pos.bottom }),
            }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
