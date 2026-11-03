/**
 * SidebarResizer — エディタパネル（サイドバー）の右端に置く幅変更の境界線（md 以上のみ）。
 *
 * - ドラッグで幅を変える。ダブルクリックで既定幅に戻す。
 * - キーボード: フォーカスして ←/→ で 16px ずつ（Shift で 64px）、Home で既定幅。
 * - 幅は App のグリッド列 `--sidebar-w` に流す（state と保存は `useSidebarWidth`）。
 */

import { useCallback, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth as clampWidth,
  saveSidebarWidth as saveWidth,
} from '../hooks/useSidebarWidth';

export interface SidebarResizerProps {
  width: number | null;
  onChange: (next: number | null) => void;
  /** 幅を測る対象（サイドバーの要素）。未設定時の実幅を起点にするため。 */
  targetRef: React.RefObject<HTMLElement | null>;
}

export function SidebarResizer({ width, onChange, targetRef }: SidebarResizerProps) {
  const { t } = useTranslation();
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);

  const currentWidth = useCallback(
    () => width ?? targetRef.current?.getBoundingClientRect().width ?? 320,
    [width, targetRef],
  );

  const commit = useCallback(
    (next: number | null) => {
      onChange(next);
      saveWidth(next);
    },
    [onChange],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startWidth = targetRef.current?.getBoundingClientRect().width ?? currentWidth();
    drag.current = { startX: e.clientX, startWidth, last: startWidth };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampWidth(d.startWidth + e.clientX - d.startX);
    onChange(d.last);
  };
  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    saveWidth(d.last);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      commit(clampWidth(currentWidth() + dir * step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      commit(null);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width ?? undefined}
      title={t('sidebar.resizeHint')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKeyDown}
      // 罫線（border-r）の上に中心を重ねる。掴みやすいよう当たり判定は 8px、見た目の線は 2px。
      className="group absolute top-0 right-0 z-20 hidden h-full w-2 translate-x-1/2 cursor-col-resize touch-none focus:outline-none md:block"
    >
      <span
        aria-hidden
        className={
          'pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ' +
          (dragging
            ? 'bg-primary'
            : 'bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary')
        }
      />
    </div>
  );
}
