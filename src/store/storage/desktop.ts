/**
 * Desktop 向け BinaryStorage 実装。
 * appDataDir/binaries/<key> に実ファイルとして置く（CLAUDE.md 第7.2章）。
 *
 * fs プラグインのフロント API スコープは開けない方針（lib.rs 冒頭参照）のため、
 * Rust 側の専用コマンド binary_put / binary_get / binary_delete / binary_keys を使う。
 * 本モジュールは `storage/index.ts` から**動的 import 経由でのみ**到達するので、
 * `@tauri-apps/api` の静的 import が Web バンドルに混入することはない。
 */

import { invoke } from '@tauri-apps/api/core';
import type { BinaryStorage } from './types';

/**
 * Rust から戻る `Vec<u8>` は serde 既定で JSON 数値配列になる。
 * `adapters/desktop.ts` の `toUint8Array` と同じ受け方（ファイル間依存を避けて再掲）。
 */
function toUint8Array(value: unknown): Uint8Array {
  if (!Array.isArray(value)) {
    throw new Error('binary_get: Rust から想定外の型が返りました（数値配列を期待）');
  }
  return Uint8Array.from(value as number[]);
}

export class DesktopBinaryStorage implements BinaryStorage {
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await invoke('binary_put', { key, bytes });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = await invoke<unknown>('binary_get', { key });
    if (value === null || value === undefined) return null;
    return toUint8Array(value);
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
