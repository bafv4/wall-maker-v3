import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from './cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  // id を渡さない呼び出し元でもラベルと結び付ける（htmlFor が空だとラベルが読み上げられない）。
  const autoId = useId();
  const inputId = id ?? rest.name ?? autoId;
  const note = error ?? hint;
  const noteId = `${inputId}-note`;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={inputId}
          className="text-xs font-medium text-fg-muted"
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cn(
          'h-10 w-full rounded-md border bg-surface px-3 text-sm text-fg transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
          'disabled:bg-panel disabled:text-fg-subtle',
          error ? 'border-red-400 dark:border-red-700' : 'border-border-strong',
          className,
        )}
        {...rest}
      />
      {error ? (
        <span id={noteId} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="text-xs text-fg-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
});
