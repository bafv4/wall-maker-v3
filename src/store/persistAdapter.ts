/**
 * Zustand `persist` 用の非同期 StateStorage アダプタ。
 * 仕様: REWRITE_SPEC.md 第7.2章。
 *
 * 仕組み:
 *  - 軽い state（JSON 可能な値）は localStorage に書く。
 *  - バイナリ（BinaryRef の inline）は `BinaryStorage`（Web=IndexedDB / Desktop=appDataDir）に書き、
 *    state 内では `{ kind: 'ref', storageKey, mimeType }` に置換される。
 *  - hydrate 時は逆方向：localStorage を読み JSON.parse → 各 ref を BinaryStorage から復元して inline 化。
 *  - 該当エントリ無しは warn してそのフィールドを安全側フォールバック（serialize.ts 参照）。
 *
 * 永続化対象は WallState のみ（partialize で UI state を捨てる前提）。
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { WallState } from '../core/state';
import { getBinaryStorage } from './storage';
import {
  extractBinariesToRefs,
  resolveBinariesToInline,
} from './serialize';

export interface PersistedWallStore {
  wall: WallState;
}

export const wallStorePersistStorage: PersistStorage<PersistedWallStore> = {
  async getItem(name) {
    const raw = localStorage.getItem(name);
    if (!raw) return null;
    let parsed: StorageValue<PersistedWallStore>;
    try {
      parsed = JSON.parse(raw) as StorageValue<PersistedWallStore>;
    } catch (e) {
      console.warn(
        `wallStorePersistStorage: failed to parse persisted state "${name}"`,
        e,
      );
      return null;
    }
    const storage = await getBinaryStorage();
    const wall = await resolveBinariesToInline(parsed.state.wall, storage);
    return { state: { wall }, version: parsed.version };
  },

  async setItem(name, value) {
    const storage = await getBinaryStorage();
    const wall = await extractBinariesToRefs(value.state.wall, storage);
    const toPersist: StorageValue<PersistedWallStore> = {
      state: { wall },
      version: value.version,
    };
    localStorage.setItem(name, JSON.stringify(toPersist));
  },

  removeItem(name) {
    localStorage.removeItem(name);
  },
};
