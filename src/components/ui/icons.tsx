/**
 * icons — ボタンなどに使う小さな線アイコン。
 *
 * 文字（× ▾ ✓ ↑ ↓）で代用すると、書体ごとに太さ・高さ・位置がばらつくため SVG で揃える。
 * 24px グリッド・線幅 2・丸キャップ。色は `currentColor`、大きさは `className` で決める。
 * 装飾なので常に `aria-hidden`（読み上げ名はボタン側の aria-label に持たせる）。
 */

import type { ReactNode } from 'react';
import { cn } from './cn';

interface IconProps {
  className?: string;
}

function LineIcon({
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 flex-shrink-0', className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </LineIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M6 9l6 6 6-6" />
    </LineIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 5v14M5 12h14" />
    </LineIcon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M15 6l-6 6 6 6" />
    </LineIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </LineIcon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </LineIcon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </LineIcon>
  );
}
