/**
 * Select — カスタムポップオーバー版ドロップダウン。
 *
 * ネイティブ `<select>` ではなくボタン + 浮遊リストで実装。
 *  - Portal で `document.body` 直下にレンダリングするため、深い stacking context や
 *    `overflow:hidden` の親の影響を受けない。
 *  - 外側クリック / Escape / スクロール / リサイズで自動的に閉じる。
 *  - 選択中の項目には ✓ を表示。hover とフォーカスでスタイルが変わる。
 *  - 旧 API（`onChange: ChangeEvent`）から `onValueChange(value: string)` に変更。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface SelectOption {
  value: string;
  label: string;
  /** 補足説明（オプション内の右側に薄い文字で表示） */
  hint?: string;
}

export interface SelectProps {
  label?: string;
  options: SelectOption[];
  value: string;
  onValueChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
}

interface PopoverRect {
  left: number;
  width: number;
  /** ポップオーバーの最大高さ。ビューポート下端／上端で切れないよう動的に決める。 */
  maxHeight: number;
  /**
   * 配置方向。
   *  - `'down'`: ``top`` をトリガー直下に置く（content は top から下に伸びる）
   *  - `'up'`  : ``bottom`` をトリガー直上に固定（content は bottom から上に伸びる）
   *
   * up のときに `top` を使うと、`top = r.top - gap - maxHeight` のように
   * 最大高さぶん上に飛ばしてしまい、実コンテンツが短いとトリガーとの間に
   * 巨大な空白ができる。`bottom` 固定なら content の実高さに関わらず常にトリガー直上。
   */
  mode: 'down' | 'up';
  top?: number;
  bottom?: number;
}

/** 理想的なポップオーバーの最大高さ（旧 `max-h-64`）。実値はビューポート空間に応じて縮む。 */
const PREFERRED_MAX_HEIGHT = 256;
/** ビューポート端からの最小マージン。 */
const VIEWPORT_MARGIN = 8;
/** トリガーとポップオーバーの間隔。 */
const POPOVER_GAP = 4;
/** どちら向きに開いてもスペースが狭いときに確保する最小高さ。 */
const MIN_POPOVER_HEIGHT = 64;
/** 1 オプション行の概算高さ（`text-sm` + `py-2` = 約 36px）。 */
const OPTION_HEIGHT_ESTIMATE = 36;
/** `<ul>` の上下 padding（`py-1` = 4px × 2）。 */
const POPOVER_VERTICAL_PADDING = 8;

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    options,
    value,
    onValueChange,
    disabled,
    id,
    name,
    className,
    placeholder,
  },
  forwardedRef,
) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<PopoverRect | null>(null);

  useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement);

  const selectedLabel = options.find((o) => o.value === value)?.label;

  // 実際のコンテンツ高さを見積もって、それが収まる側を優先する。
  // `PREFERRED_MAX_HEIGHT` (256px) をしきい値にすると 4 項目（~150px）でも
  // 「下に余裕があるが PREFERRED に届かない」中間ケースで下に開いて見切れる。
  const estimatedContentHeight = Math.min(
    PREFERRED_MAX_HEIGHT,
    options.length * OPTION_HEIGHT_ESTIMATE + POPOVER_VERTICAL_PADDING,
  );

  const computeRect = useCallback((): PopoverRect | null => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return null;
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - r.bottom - VIEWPORT_MARGIN;
    const spaceAbove = r.top - VIEWPORT_MARGIN;

    // 推定コンテンツ高さが収まる側を優先。両方収まらない場合は広い方。
    const needed = estimatedContentHeight + POPOVER_GAP;
    const fitsBelow = spaceBelow >= needed;
    const fitsAbove = spaceAbove >= needed;
    const openDown =
      fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);

    const available = openDown ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(
      MIN_POPOVER_HEIGHT,
      Math.min(PREFERRED_MAX_HEIGHT, available - POPOVER_GAP),
    );
    return openDown
      ? {
          mode: 'down',
          top: r.bottom + POPOVER_GAP,
          left: r.left,
          width: r.width,
          maxHeight,
        }
      : {
          mode: 'up',
          // ビューポート下端からトリガー上端の `POPOVER_GAP` 上までを bottom 値で固定。
          // 実コンテンツ高さに関わらず常にトリガー直上に貼り付く。
          bottom: viewportH - r.top + POPOVER_GAP,
          left: r.left,
          width: r.width,
          maxHeight,
        };
  }, [estimatedContentHeight]);

  const handleOpen = useCallback(() => {
    if (disabled) return;
    setRect(computeRect());
    setOpen(true);
  }, [disabled, computeRect]);

  // 開いている間: 外側操作で閉じる
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onResize = () => setOpen(false);
    const onScroll = (e: Event) => {
      // popover 内部のスクロールでは閉じない
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // 開いた直後に最新位置を計測（フォントロード等のずれ対策）
  useLayoutEffect(() => {
    if (!open) return;
    const r = computeRect();
    if (r) setRect(r);
  }, [open, computeRect]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label
          htmlFor={id}
          className="text-xs font-medium text-fg-muted"
        >
          {label}
        </label>
      )}
      <button
        ref={triggerRef}
        id={id}
        name={name}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : handleOpen())}
        className={cn(
          'inline-flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm text-fg transition-colors',
          'cursor-pointer hover:border-slate-400 dark:hover:border-neutral-500',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-transparent',
          'disabled:cursor-not-allowed disabled:bg-panel disabled:text-fg-subtle',
          open && 'border-blue-400 ring-2 ring-blue-500',
        )}
      >
        <span
          className={cn(
            'truncate text-left',
            !selectedLabel && 'text-fg-subtle',
          )}
        >
          {selectedLabel ?? placeholder ?? '選択…'}
        </span>
        <span
          className={cn(
            'flex-shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open &&
        rect &&
        createPortal(
          <ul
            ref={popoverRef}
            role="listbox"
            className="fixed z-[70] overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg ring-1 ring-black/5 dark:ring-white/10"
            style={{
              // mode に応じて top または bottom を排他で指定する。
              // up のとき top を併用すると CSS の解決で位置がずれるため省略する。
              ...(rect.mode === 'down'
                ? { top: rect.top }
                : { bottom: rect.bottom }),
              left: rect.left,
              width: rect.width,
              maxHeight: rect.maxHeight,
            }}
          >
            {options.length === 0 ? (
              <li className="px-3 py-2 text-xs text-fg-subtle">選択肢なし</li>
            ) : (
              options.map((o) => {
                const active = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onValueChange(o.value);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-fg transition-colors',
                        'cursor-pointer hover:bg-muted focus:bg-muted focus:outline-none',
                        active &&
                          'bg-accent-soft text-accent-soft-fg hover:bg-accent-soft',
                      )}
                    >
                      <span className="flex flex-1 items-center gap-2 truncate">
                        <span className="truncate">{o.label}</span>
                        {o.hint && (
                          <span className="text-[11px] text-fg-subtle">
                            {o.hint}
                          </span>
                        )}
                      </span>
                      {active && (
                        <span className="text-accent-soft-fg" aria-hidden>
                          ✓
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
});
