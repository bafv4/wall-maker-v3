import type { CSSProperties, InputHTMLAttributes } from 'react';
import { cn } from './cn';

export interface RangeInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max'> {
  value: number;
  min: number;
  max: number;
}

/**
 * スライダー。どのブラウザ/WebView でも Firefox の描画に合わせた見た目にする（App.css の `.range-input`）。
 * WebKit 系にはつまみより手前（進捗）だけを塗る擬似要素が無いので、値の割合を `--range-p` で渡す。
 */
export function RangeInput({ value, min, max, className, style, ...rest }: RangeInputProps) {
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      className={cn('range-input accent-primary', className)}
      style={{ '--range-p': ratio, ...style } as CSSProperties}
      {...rest}
    />
  );
}
