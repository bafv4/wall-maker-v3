/**
 * Desktop 向け BinaryStorage 実装（Phase 7 で本実装）。
 * appDataDir/binaries/ 配下に <key> ファイルとして書く想定。
 * 現段階はスタブ。Phase 7 で Tauri fs/path API を動的 import して実装する。
 */

import type { BinaryStorage } from './types';

export class DesktopBinaryStorage implements BinaryStorage {
  put(_key: string, _bytes: Uint8Array): Promise<void> {
    return Promise.reject(
      new Error('DesktopBinaryStorage: not implemented (Phase 7)'),
    );
  }

  get(_key: string): Promise<Uint8Array | null> {
    return Promise.reject(
      new Error('DesktopBinaryStorage: not implemented (Phase 7)'),
    );
  }

  delete(_key: string): Promise<void> {
    return Promise.reject(
      new Error('DesktopBinaryStorage: not implemented (Phase 7)'),
    );
  }

  keys(): Promise<string[]> {
    return Promise.reject(
      new Error('DesktopBinaryStorage: not implemented (Phase 7)'),
    );
  }
}
