/**
 * useObjectUrl — インメモリのバイナリ（`BinaryRef` の inline）を `<img>` で表示するための blob URL。
 *
 * URL の作成と破棄を同じ effect に置く。`useMemo` で作って別の effect の後始末で破棄すると、
 * StrictMode（開発時）の effect 再実行で破棄だけが走り、memo に残った破棄済み URL で画像が壊れる。
 * layout effect にしているのは、描画前に URL を揃えて初回に「未読込」の表示が一瞬出ないようにするため。
 */

import { useLayoutEffect, useState } from 'react';
import type { BinaryRef } from '../core/state';

/** `source` が無い、または未ロード（`kind: 'ref'`）のときは null。 */
export function useObjectUrl(
  source: BinaryRef | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!source || source.kind !== 'inline') {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(
      // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
      new Blob([source.bytes as Uint8Array<ArrayBuffer>], {
        type: source.mimeType ?? 'image/png',
      }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);

  return url;
}
