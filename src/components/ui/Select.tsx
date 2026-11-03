/**
 * Select — カスタムポップオーバー版ドロップダウン。
 *
 * ネイティブ `<select>` ではなくトリガー + 浮遊リストで実装。
 *  - Portal で `document.body` 直下にレンダリングするため、深い stacking context や
 *    `overflow:hidden` の親の影響を受けない。
 *  - 外側クリック / Escape / スクロール / リサイズで自動的に閉じる。
 *  - 選択中の項目には ✓ を表示。hover とキーボードの現在位置でスタイルが変わる。
 *  - 旧 API（`onChange: ChangeEvent`）から `onValueChange(value: string)` に変更。
 *
 * キーボード（WAI-ARIA の select-only combobox）:
 *  - フォーカスはトリガーに置いたまま、現在位置を `aria-activedescendant` で示す
 *    （リストは body 直下にあり、Tab 順ではトリガーから遠いため）。
 *  - 閉: ↓ / ↑ / Enter / Space で開く。Home / End は端を指して開く。
 *  - 開: ↓ / ↑ / Home / End で移動、Enter / Space で決定、Escape / Tab で閉じる。
 *  - トリガーを `<button>` にしないのは、Enter / Space のキー操作とネイティブの click
 *    （Space は keyup で発火）が二重に開閉させるため。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
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
  className?: string;
  placeholder?: string;
  /** `label` を出さないときの読み上げ名（見出しが別の場所にある行など）。 */
  'aria-label'?: string;
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

export const Select = forwardRef<HTMLDivElement, SelectProps>(function Select(
  {
    label,
    options,
    value,
    onValueChange,
    disabled,
    id,
    className,
    placeholder,
    'aria-label': ariaLabel,
  },
  forwardedRef,
) {
  // `placeholder` 未指定時の既定文言と空リスト時の文言は翻訳から取る。
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<PopoverRect | null>(null);
  /** キーボード / hover の現在位置（開いている間だけ意味を持つ）。 */
  const [activeIndex, setActiveIndex] = useState(-1);
  /**
   * 現在位置をキーボードで動かしているか。キーボード中は現在位置に枠を出す
   * （フォーカスの代わりなので、背景色の差だけでは見分けられない）。hover では出さない。
   */
  const [keyboardNav, setKeyboardNav] = useState(false);

  useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLDivElement);

  const autoId = useId();
  const triggerId = id ?? autoId;
  const labelId = `${triggerId}-label`;
  const listboxId = `${triggerId}-listbox`;
  const optionId = (i: number) => `${triggerId}-option-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = options[selectedIndex]?.label;

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

  /** `initial` は開いたときの現在位置（省略時は選択中の項目）。 */
  const handleOpen = useCallback(
    (initial?: number) => {
      if (disabled) return;
      setRect(computeRect());
      setActiveIndex(initial ?? Math.max(0, selectedIndex));
      setOpen(true);
    },
    [disabled, computeRect, selectedIndex],
  );

  const choose = (i: number) => {
    const option = options[i];
    if (option) onValueChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const last = options.length - 1;
    if (e.key !== 'Tab' && e.key !== 'Escape') setKeyboardNav(true);
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        handleOpen();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        handleOpen(e.key === 'Home' ? 0 : last);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(last, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(last);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(activeIndex);
        break;
      case 'Escape':
        // Modal の Escape（window で拾う）まで届かせない。リストだけ閉じる。
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  // 開いている間: 外側操作で閉じる
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    const onScroll = (e: Event) => {
      // popover 内部のスクロールでは閉じない
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
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

  // キーボードで動かした現在位置をリスト内に見せる
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${triggerId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, triggerId]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        // トリガーは <div> なので htmlFor が効かない。クリックでフォーカスだけ移す。
        <span
          id={labelId}
          onClick={() => triggerRef.current?.focus()}
          className="text-xs font-medium text-fg-muted"
        >
          {label}
        </span>
      )}
      <div
        ref={triggerRef}
        id={triggerId}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        onClick={() => {
          setKeyboardNav(false);
          if (open) setOpen(false);
          else handleOpen();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'inline-flex h-10 w-full select-none items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm text-fg transition-colors',
          'cursor-pointer hover:border-slate-400 dark:hover:border-neutral-500',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-transparent',
          'aria-disabled:cursor-not-allowed aria-disabled:bg-panel aria-disabled:text-fg-subtle aria-disabled:hover:border-border-strong',
          open && 'border-blue-400 ring-2 ring-blue-500',
        )}
      >
        <span
          className={cn(
            'truncate text-left',
            !selectedLabel && 'text-fg-subtle',
          )}
        >
          {selectedLabel ?? placeholder ?? t('common.selectPlaceholder')}
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
      </div>

      {open &&
        rect &&
        createPortal(
          <ul
            ref={popoverRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={label ? labelId : undefined}
            aria-label={label ? undefined : ariaLabel}
            // フォーカスはトリガーに残す（aria-activedescendant 方式）
            onMouseDown={(e) => e.preventDefault()}
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
              <li className="px-3 py-2 text-xs text-fg-subtle">
                {t('common.noOptions')}
              </li>
            ) : (
              options.map((o, i) => {
                const selected = o.value === value;
                return (
                  <li
                    key={o.value}
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    onClick={() => choose(i)}
                    onPointerMove={() => {
                      setKeyboardNav(false);
                      setActiveIndex(i);
                    }}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm text-fg',
                      i === activeIndex && 'bg-muted',
                      selected && 'bg-accent-soft text-accent-soft-fg',
                      i === activeIndex &&
                        keyboardNav &&
                        'ring-2 ring-inset ring-blue-500',
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
                    {selected && (
                      <span className="text-accent-soft-fg" aria-hidden>
                        ✓
                      </span>
                    )}
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
