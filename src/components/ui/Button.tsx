import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'danger-outline';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// 中立色（surface/fg/border/muted）はセマンティックトークン経由でライト/ダークが切り替わる
// （実値は App.css）。青/赤のソリッドはモード非依存なのでそのまま、赤アウトラインだけ
// ダーク時の見えづらさを補う dark: を局所的に付ける。
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900',
  secondary:
    'bg-border text-fg hover:bg-border-strong disabled:bg-panel disabled:text-fg-subtle',
  outline:
    'border border-border-strong bg-surface text-fg hover:bg-muted disabled:opacity-50',
  ghost:
    'bg-transparent text-fg-muted hover:bg-muted disabled:opacity-50',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900',
  'danger-outline':
    'border border-red-300 bg-surface text-red-600 hover:bg-red-50 hover:border-red-400 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:border-red-700',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-11 px-5 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
        'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    />
  );
}
