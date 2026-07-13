/**
 * Export Web Worker — `buildPack` と Zip 生成（JSZip）をワーカで実行し、UI スレッドを
 * フリーズさせない。仕様: REWRITE_SPEC.md 第10章 Phase 9（パフォーマンス）。
 *
 * 設計:
 *  - `kind` → 戻り値型 のマッピングを `ExportRequestMap` で 1 箇所に集約する。エンドポイントを
 *    追加するときは map に 1 行・実装に 1 ケースを足すだけで client / response 型も追従する。
 *  - `state` は postMessage の structured clone でコピーされる。state 内の `Uint8Array` は
 *    新しいバッファになるため、ワーカ内の `bitmapCache` キャッシュは 1 リクエスト内でのみ有効。
 *  - レスポンスのバイト列は `transfer` リストで所有権ごと返し、コピーを避ける。
 *  - Canvas 処理は `OffscreenCanvas` を使うため main / worker で同じコードが動く
 *    （`core/buildPack.ts` の `createCanvas` 参照）。
 */

import { packToZipBytes } from '../adapters/web';
import { buildPack } from '../core/buildPack';
import type { WallState } from '../core/state';
import type { VirtualPack } from '../core/types';

/** kind → 戻り値型 の対応表。client / worker / response 型の単一ソース。 */
export interface ExportRequestMap {
  buildAndZip: Uint8Array;
  buildPack: VirtualPack;
}

export type ExportRequestKind = keyof ExportRequestMap;

export interface ExportRequest<K extends ExportRequestKind = ExportRequestKind> {
  id: number;
  kind: K;
  state: WallState;
}

export type ExportResponse =
  | { id: number; ok: true; result: ExportRequestMap[ExportRequestKind] }
  | { id: number; ok: false; error: string };

/** kind ごとの実装。新エンドポイントはここに 1 ケース足すだけ。 */
const handlers: {
  [K in ExportRequestKind]: (
    state: WallState,
  ) => Promise<ExportRequestMap[K]>;
} = {
  buildAndZip: async (state) => {
    const pack = await buildPack(state);
    return packToZipBytes(pack);
  },
  buildPack: (state) => buildPack(state),
};

/**
 * 結果から transferable な ArrayBuffer を収集する。
 * 同一バッファを複数エントリが共有し得るため重複排除が必須
 * （postMessage は重複 transfer を DataCloneError で拒否する）。
 */
function collectTransferables(result: unknown): Transferable[] {
  // TS 5.7+ の Uint8Array.buffer は ArrayBufferLike（SharedArrayBuffer を含む）だが、
  // 本アプリのバイナリは常に実 ArrayBuffer 由来なので絞り込んで扱う。
  const buffers = new Set<ArrayBuffer>();
  if (result instanceof Uint8Array) {
    buffers.add(result.buffer as ArrayBuffer);
  } else if (result instanceof Map) {
    for (const v of result.values()) {
      if (v instanceof Uint8Array) buffers.add(v.buffer as ArrayBuffer);
    }
  }
  return [...buffers];
}

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const req = e.data;
  try {
    const handler = handlers[req.kind];
    const result = await handler(req.state);
    ctx.postMessage(
      { id: req.id, ok: true, result } satisfies ExportResponse,
      collectTransferables(result),
    );
  } catch (err) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExportResponse);
  }
};
