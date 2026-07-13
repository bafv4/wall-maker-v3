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
 * 堅牢性の不変条件:
 *  - **`getItem` は絶対に reject しない**。zustand persist は hydration の reject を
 *    （`onRehydrateStorage` 未設定なら）黙って握り潰し、`hasHydrated` が false のまま
 *    `onFinishHydration` も発火しないため、App がローディング画面から永久に抜けられなくなる。
 *    復元に失敗したら null（既定 state で起動）に倒し、エラーはログ＋トーストで通知する。
 *  - **`setItem` は直列化＋最新値のみ書く**。zustand は setItem を await しないため、
 *    素朴な実装だと連続更新（ドラッグ中は pointermove ごと）で書き込みが並走し、
 *    古い state の書き込みが後から完了して新しい state を上書きし得る。
 *    キューは常に最新値 1 件だけ保持し、中間状態の書き込みは捨てる。
 *  - **GC は保守的に**。過去セッションの孤児キーの全走査掃除は hydrate 直後に 1 回だけ
 *    （＝別タブがまだ何も書いていない、localStorage と最も整合したタイミング）。
 *    書き込み後は「前回参照していて今回参照しなくなったキー」の増分だけ削除する。
 *    どちらも削除直前に localStorage の現行 JSON を読み直し、
 *    （別タブが書いた可能性のある）参照中キーはスキップする。削除はキー単位で失敗を
 *    隔離し、1 件の失敗（例: appDataDir/binaries への外来ファイル）で残りを打ち切らない。
 *
 * 既知の制限: 複数タブ/ウィンドウでの同時編集は localStorage が last-write-wins のため
 * もともとサポート外（後勝ちで上書き）。GC はその前提の中で「実体バイナリを消さない」
 * 側に倒してある（B タブの put 完了〜localStorage 反映のごく短い窓だけは保護できない）。
 *
 * 永続化対象は WallState のみ（partialize で UI state を捨てる前提）。
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';
import i18n from '../i18n';
import { toast } from '../components/ui/Toast';
import type { WallState } from '../core/state';
import { getBinaryStorage } from './storage';
import type { BinaryStorage } from './storage/types';
import {
  collectReferencedKeys,
  extractBinariesToRefs,
  noteBinaryKeyDeleted,
  resolveBinariesToInline,
} from './serialize';

export interface PersistedWallStore {
  wall: WallState;
}

// ---------------------------------------------------------------------------
// setItem の直列化キュー（最新値のみ・latest-wins）
// ---------------------------------------------------------------------------

let queuedValue: StorageValue<PersistedWallStore> | null = null;
let flushing = false;
/** 失敗トーストの連発防止。成功で解除し、次の失敗でまた 1 回だけ出す。 */
let failureNotified = false;

async function ensureFlushing(name: string): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queuedValue) {
      const value = queuedValue;
      queuedValue = null;
      try {
        const storage = await getBinaryStorage();
        const wall = await extractBinariesToRefs(value.state.wall, storage);
        const toPersist: StorageValue<PersistedWallStore> = {
          state: { wall },
          version: value.version,
        };
        localStorage.setItem(name, JSON.stringify(toPersist));
        failureNotified = false;
        await gcAfterWrite(wall, storage, name);
      } catch (e) {
        console.error('wallStorePersistStorage: failed to persist state', e);
        if (!failureNotified) {
          failureNotified = true;
          toast.error(i18n.t('toast.persistFailed'));
        }
      }
    }
  } finally {
    flushing = false;
    // ループ脱出とフラグ解除の間に積まれた値の取りこぼし防止。
    if (queuedValue) void ensureFlushing(name);
  }
}

// ---------------------------------------------------------------------------
// GC — 参照されなくなった BinaryStorage キーの掃除
// ---------------------------------------------------------------------------

let lastReferencedKeys: Set<string> | null = null;

/**
 * localStorage の現行 JSON が参照しているキー集合。
 * 削除直前の再確認に使う（別タブの書き込みを踏み潰さないため）。
 * 読めない/解釈できない場合は null（＝安全側: 何も削除しない）。
 */
function readCurrentPersistedKeys(name: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(name);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as StorageValue<PersistedWallStore>;
    const wall: unknown = parsed?.state?.wall;
    if (typeof wall !== 'object' || wall === null) return null;
    return collectReferencedKeys(wall as WallState);
  } catch {
    return null;
  }
}

/**
 * キー集合を「localStorage 現行参照との突き合わせ → キー単位の失敗隔離」で削除する。
 * 1 件の delete 失敗（例: Desktop の binaries フォルダに OS が作る外来ファイル）で
 * 残りの掃除を打ち切らない。
 */
async function deleteKeysSafely(
  storage: BinaryStorage,
  keys: Iterable<string>,
  name: string,
): Promise<void> {
  const currentRefs = readCurrentPersistedKeys(name);
  if (currentRefs === null) return; // 現行 JSON を確認できないときは削除しない
  for (const key of keys) {
    if (currentRefs.has(key)) continue; // 別タブ等が参照中
    try {
      await storage.delete(key);
      noteBinaryKeyDeleted(key);
    } catch (e) {
      console.warn(
        `wallStorePersistStorage: GC delete failed for key "${key}" — skipped`,
        e,
      );
    }
  }
}

/**
 * hydrate 直後の孤児掃除（全走査）。過去セッションのクラッシュ等で残ったキーを回収する。
 * このタイミングなら localStorage の JSON が「唯一の真実」で、別タブの新規書き込みと
 * 競合する余地が最も小さい。fire-and-forget（失敗しても起動は続行）。
 */
async function sweepOrphanKeys(
  storage: BinaryStorage,
  referenced: Set<string>,
  name: string,
): Promise<void> {
  try {
    const all = await storage.keys();
    const orphans = all.filter((k) => !referenced.has(k));
    if (orphans.length > 0) {
      await deleteKeysSafely(storage, orphans, name);
    }
  } catch (e) {
    console.warn('wallStorePersistStorage: orphan sweep failed', e);
  }
}

/** 書き込み後の増分 GC。「前回参照 − 今回参照」だけを対象にする。 */
async function gcAfterWrite(
  persistedWall: WallState,
  storage: BinaryStorage,
  name: string,
): Promise<void> {
  const referenced = collectReferencedKeys(persistedWall);
  if (lastReferencedKeys) {
    const removed = [...lastReferencedKeys].filter((k) => !referenced.has(k));
    if (removed.length > 0) {
      await deleteKeysSafely(storage, removed, name);
    }
  }
  lastReferencedKeys = referenced;
}

// ---------------------------------------------------------------------------
// StateStorage 実装
// ---------------------------------------------------------------------------

export const wallStorePersistStorage: PersistStorage<PersistedWallStore> = {
  async getItem(name) {
    try {
      const raw = localStorage.getItem(name);
      if (!raw) {
        // 永続 JSON が無い＝何も参照されていない。残存バイナリ（localStorage だけ
        // 消された場合など）は孤児として回収する。
        const storage = await getBinaryStorage();
        lastReferencedKeys = new Set();
        void sweepOrphanKeys(storage, new Set(), name);
        return null;
      }
      const parsed = JSON.parse(raw) as StorageValue<PersistedWallStore>;
      const persistedWall: unknown = parsed?.state?.wall;
      if (typeof persistedWall !== 'object' || persistedWall === null) {
        console.warn(
          `wallStorePersistStorage: persisted state "${name}" has no wall — starting fresh`,
        );
        return null;
      }
      const storage = await getBinaryStorage();
      const wall = await resolveBinariesToInline(
        persistedWall as WallState,
        storage,
      );
      // 孤児掃除は「復元に使った参照集合」を基準に非同期で 1 回だけ。
      const referenced = collectReferencedKeys(persistedWall as WallState);
      lastReferencedKeys = referenced;
      void sweepOrphanKeys(storage, referenced, name);
      return { state: { wall }, version: parsed.version };
    } catch (e) {
      // reject すると App が永久ローディングになる（冒頭の不変条件参照）。
      console.error(
        `wallStorePersistStorage: failed to restore "${name}" — starting fresh`,
        e,
      );
      // hydration は React マウント前なので Toast は console フォールバックになるが、
      // 遅延マウント環境でも拾えるよう一応通す。
      toast.error(i18n.t('toast.restoreFailed'));
      return null;
    }
  },

  setItem(name, value) {
    // 最新値だけ残す。書き込み中に来た中間状態は上書きされて消える。
    queuedValue = value;
    void ensureFlushing(name);
    return Promise.resolve();
  },

  removeItem(name) {
    localStorage.removeItem(name);
  },
};
