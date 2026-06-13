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

/** 結果から transferable な ArrayBuffer を収集する。 */
function collectTransferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) return [result.buffer];
  if (result instanceof Map) {
    const out: Transferable[] = [];
    for (const v of result.values()) {
      if (v instanceof Uint8Array) out.push(v.buffer);
    }
    return out;
  }
  return [];
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
