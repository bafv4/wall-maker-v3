/**
 * Export Worker クライアント — シングルトンの Worker を起動し、Promise ベースの API を提供する。
 *
 * 仕様: REWRITE_SPEC.md 第10章 Phase 9（パフォーマンス）。
 *
 * 設計:
 *  - エンドポイントごとに型安全な呼び出し関数を `send<K>` 越しに提供する。
 *    kind→戻り値型 は worker 側の `ExportRequestMap` 参照（単一ソース）。
 *  - Worker は最初の呼び出しで lazy に起動。以降は使い回し（毎回 spawn しない）。
 *  - メッセージ ID で複数の並行リクエストを多重化する。
 *  - Worker が致命的にエラー（onerror）になった場合はインスタンスを破棄して次回再生成する。
 *
 * 注意:
 *  - `state` は postMessage の structured clone でコピーされる。store の元の state は不変。
 *  - 戻りの `Uint8Array` / `VirtualPack` のバイト列は transfer で所有権が移譲されるため、
 *    呼び出し側はこの結果を再利用しても問題ないが、ワーカ側からは触れなくなる。
 */

import type {
  ExportRequestKind,
  ExportRequestMap,
  ExportResponse,
} from '../workers/exportWorker';
import { errMsg } from './errors';
import type { WallState } from './state';
import type { VirtualPack } from './types';

type PendingSlot = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<number, PendingSlot>();
let nextId = 1;
let worker: Worker | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  // Vite が `?worker` クエリで Worker を別チャンクとしてバンドルする。
  // `type: 'module'` は Worker 内 ESM import のため必要。
  worker = new Worker(new URL('../workers/exportWorker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<ExportResponse>) => {
    const { id, ok } = e.data;
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (ok) slot.resolve(e.data.result);
    else slot.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    const err = new Error(`exportWorker fatal: ${errMsg(e)}`);
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function send<K extends ExportRequestKind>(
  kind: K,
  state: WallState,
): Promise<ExportRequestMap[K]> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<ExportRequestMap[K]>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    w.postMessage({ id, kind, state });
  });
}

/**
 * `buildPack(state)` + JSZip を Worker 内で実行し、.zip バイト列を返す。
 * Web のダウンロードと Desktop の `.zip` 保存の両方で使う。
 */
export function buildAndZipInWorker(state: WallState): Promise<Uint8Array> {
  return send('buildAndZip', state);
}

/**
 * `buildPack(state)` のみを Worker 内で実行し、VirtualPack を返す。
 * Desktop のフォルダ保存（zip 化不要）で使う。
 */
export function buildPackInWorker(state: WallState): Promise<VirtualPack> {
  return send('buildPack', state);
}
