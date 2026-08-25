/**
 * Desktop 向け BinaryStorage 実装。
 * appDataDir/binaries/<key> に実ファイルとして置く（CLAUDE.md 第7.2章）。
 *
 * fs プラグインのフロント API スコープは開けない方針（lib.rs 冒頭参照）のため、
 * Rust 側の専用コマンド binary_put / binary_get / binary_delete / binary_keys を使う。
 * 本モジュールは `storage/index.ts` から**動的 import 経由でのみ**到達するので、
 * `@tauri-apps/api` の静的 import が Web バンドルに混入することはない。
 *
 * put/get は **生バイトで IPC する**（serde 既定の JSON 数値配列を使わない）。
 * 詳細は `src-tauri/src/lib.rs` 冒頭の設計メモを参照。
 */

import { invoke } from '@tauri-apps/api/core';
import type { BinaryStorage } from './types';

/**
 * `binary_put` の引数コンテナ `[u32 LE metaLen][meta JSON][payload]` を組み立てる。
 *
 * Tauri 2 の `invoke` は **引数全体が ArrayBuffer / TypedArray のときだけ** 生ボディで
 * 送る。`{ key, bytes }` のようなオブジェクトで渡すと `Uint8Array` が 10 進数値配列
 * テキストに展開され、20MB の画像が 60〜70MB になる。
 * `adapters/desktop.ts` の `encodeIpcContainer` と同じ形式（あちらは
 * `@tauri-apps/plugin-dialog` / JSZip を引き込むため、ファイル間依存を避けて再掲）。
 */
function encodeIpcContainer(meta: unknown, payload: Uint8Array): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  out.set(payload, 4 + metaBytes.byteLength);
  return out;
}

export class DesktopBinaryStorage implements BinaryStorage {
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await invoke('binary_put', encodeIpcContainer({ key }, bytes));
  }

  async get(key: string): Promise<Uint8Array | null> {
    // 応答は生バイト（ArrayBuffer）。先頭 1 バイトが在否フラグ（0=不在 / 1=実体あり）で、
    // 生バイト応答に null を表す手段がないための約束（lib.rs `binary_get` と対）。
    // custom protocol IPC が使えない webview では postMessage にフォールバックし、
    // その経路では 10 進数値配列で返るため互換のため受ける（低速だが動く）。
    const value = await invoke<unknown>('binary_get', { key });
    let view: Uint8Array;
    if (value instanceof ArrayBuffer) {
      view = new Uint8Array(value);
    } else if (Array.isArray(value)) {
      view = Uint8Array.from(value as number[]);
    } else {
      throw new Error(
        'binary_get: Rust から想定外の型が返りました（ArrayBuffer を期待）',
      );
    }
    if (view.byteLength < 1) {
      throw new Error('binary_get: 応答が空です（在否フラグなし）');
    }
    if (view[0] === 0) return null;
    // slice でフラグを落として独立バッファにする。state に載るバイト列は
    // Worker への transfer 対象（`workers/exportWorker.ts`）なので、
    // byteOffset 付きビューを持ち回らない。
    return view.slice(1);
  }

  async delete(key: string): Promise<void> {
    await invoke('binary_delete', { key });
  }

  async keys(): Promise<string[]> {
    const value = await invoke<unknown>('binary_keys');
    if (!Array.isArray(value)) {
      throw new Error('binary_keys: Rust から想定外の型が返りました（文字列配列を期待）');
    }
    return (value as unknown[]).map((k) => String(k));
  }
}
