import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from './cn';
import { ChevronDownIcon } from './icons';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 入力欄と上下ボタンを重ねる外枠のクラス。幅や外側の余白（mt-* など）はこちらに付ける。 */
  wrapperClassName?: string;
  /**
   * 上下ボタンの列に足すクラス。入力欄の枠の内側に収まるよう、角丸は入力欄より 1px 小さく、
   * 区切り線は入力欄の枠と同じ色にする（既定は `rounded`・`border-border-strong` の入力欄向け）。
   */
  stepperClassName?: string;
}

/** 押し続けたときに連続で増減を始めるまでの時間と、その間隔。 */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 50;

/**
 * 数値入力。ブラウザ標準の上下ボタン（Chromium と Firefox で形も大きさも違う）を消し、
 * 入力欄の高さいっぱいを使う上下ボタンを右端に重ねる。
 *
 * ボタンは標準の上下ボタンと同じく入力欄にフォーカスを置いたまま値を増減し、`input` イベントを
 * 送って呼び出し元の onChange に流す（blur で確定する呼び出し元もそのまま動く）。
 * キーボードでは入力欄の ↑/↓ キーで増減できるので、ボタン自体はフォーカス対象・読み上げ対象にしない。
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    { wrapperClassName, stepperClassName, className, disabled, ...rest },
    ref,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);
    const repeatTimer = useRef<number | undefined>(undefined);

    const stopRepeat = () => {
      window.clearTimeout(repeatTimer.current);
      repeatTimer.current = undefined;
    };
    useEffect(() => stopRepeat, []);

    const step = (direction: 1 | -1) => {
      const input = inputRef.current;
      if (!input) return;
      try {
        if (direction > 0) input.stepUp();
        else input.stepDown();
      } catch {
        // 値が数値として解釈できない（"1e999" など）と増減できない。標準のボタンと同じく何もしない。
        return;
      }
      // stepUp/stepDown はイベントを出さないので、React の onChange に届くよう input を送る。
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const startRepeat =
      (direction: 1 | -1) => (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        // ボタンにフォーカスを移さない（入力欄の blur で値を確定する呼び出し元がある）。
        e.preventDefault();
        inputRef.current?.focus();
        stopRepeat();
        step(direction);
        const tick = (delay: number) => {
          repeatTimer.current = window.setTimeout(() => {
            step(direction);
            tick(REPEAT_INTERVAL_MS);
          }, delay);
        };
        tick(REPEAT_DELAY_MS);
      };

    const buttonClass = cn(
      'flex min-h-0 flex-1 cursor-default items-center justify-center text-fg-subtle',
      'hover:bg-muted hover:text-fg active:bg-border',
      'disabled:pointer-events-none disabled:opacity-50',
    );
    const buttonHandlers = {
      type: 'button' as const,
      tabIndex: -1,
      disabled,
      onPointerUp: stopRepeat,
      onPointerLeave: stopRepeat,
      onPointerCancel: stopRepeat,
      // pointerdown を止めてもフォーカスが移るブラウザがあるので mousedown も止める。
      onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    };

    return (
      <span className={cn('relative block', wrapperClassName)}>
        <input
          ref={inputRef}
          type="number"
          disabled={disabled}
          className={cn(
            // 標準の上下ボタンを消す（Firefox は appearance、Chromium/WebKit は擬似要素）。
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            className,
            'pr-6',
          )}
          {...rest}
        />
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-px right-px flex w-5 flex-col overflow-hidden rounded-r-[3px] border-l border-border-strong',
            stepperClassName,
          )}
        >
          <button
            {...buttonHandlers}
            onPointerDown={startRepeat(1)}
            className={buttonClass}
          >
            <ChevronDownIcon className="size-3 rotate-180" />
          </button>
          <button
            {...buttonHandlers}
            onPointerDown={startRepeat(-1)}
            className={buttonClass}
          >
            <ChevronDownIcon className="size-3" />
          </button>
        </span>
      </span>
    );
  },
);
