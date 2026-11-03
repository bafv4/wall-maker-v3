/**
 * packRead — VirtualPack（外部入力）を読むための小さなガード群。
 * parsePack と editorMeta が共有する。値の型注釈は信用せず、ここで絞り込む。
 */

import type { VirtualPack } from './types';

/** バイナリとして読む。無い・JSON テキストが入っている場合は null。 */
export function readBytes(pack: VirtualPack, path: string): Uint8Array | null {
  const v = pack.get(path);
  if (v === undefined) return null;
  if (typeof v === 'string') return null; // JSON テキスト相手にこの API は使わない
  return v;
}

/** テキストとして読む。バイナリで入っていれば UTF-8 として decode する。無ければ null。 */
export function readString(pack: VirtualPack, path: string): string | null {
  const v = pack.get(path);
  if (v === undefined) return null;
  if (typeof v === 'string') return v;
  // Uint8Array の場合は UTF-8 として decode（VirtualPack 内に JSON がバイナリで入っているケース）
  try {
    return new TextDecoder('utf-8').decode(v);
  } catch {
    return null;
  }
}

/** 配列でないプレーンなオブジェクトか（JSON オブジェクトの判定用）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
