/**
 * ExternalLink — 外部 URL を開くリンク。
 *
 * Tauri webview 内の `<a target="_blank">` は環境依存で無反応になるため、
 * クリックは adapter の `openExternalUrl` に委ねる（Desktop = opener プラグインで
 * 既定ブラウザ、Web = 通常の新規タブ）。href / target / rel は、ハンドラが
 * 実行されない状況（JS エラー等）でのフォールバックとして残す。
 */

import { openExternalUrl } from '../../adapters';

export interface ExternalLinkProps {
  href: string;
  // Trans に渡すときは children が空のまま使うため optional。
  children?: React.ReactNode;
  /** 省略時は本文中リンクの既定スタイル。 */
  className?: string;
}

export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'text-blue-600 underline hover:text-blue-800'}
      onClick={(e) => {
        e.preventDefault();
        void openExternalUrl(href).catch((err: unknown) => {
          console.warn('open external url failed', err);
        });
      }}
    >
      {children}
    </a>
  );
}
