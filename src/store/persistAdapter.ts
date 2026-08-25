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
 *  - **`setItem` は間引く（先頭即時＋最小間隔）**。zustand persist は `set()` のたびに
 *    setItem を呼ぶため、素朴に書くと pointermove / スライダー / キーストローク 1 回ごとに
 *    「ref 抽出（全レイヤ・全 lock 画像・13 サウンドの走査）→ JSON.stringify →
 *    同期 localStorage 書き込み → GC」がフルで走る。バーストは
 *    {@link PERSIST_THROTTLE_MS} ごとに 1 回へ畳む。ドラッグ中の中間状態は失って
 *    構わないが、区切り（pointerup / タブ非表示 / 離脱）では強制フラッシュする。
 *  - **GC は保守的に**。過去セッションの孤児キーの全走査掃除は hydrate 直後に 1 回だけ
 *    （＝別タブがまだ何も書いていない、localStorage と最も整合したタイミング）。
 *    書き込み後は「前回参照していて今回参照しなくなったキー」の増分だけ削除する。
 *    どちらも削除直前に localStorage の現行 JSON を読み直し、
 *    （別タブが書いた可能性のある）参照中キーはスキップする。削除はキー単位で失敗を
 *    隔離し、1 件の失敗（例: appDataDir/binaries への外来ファイル）で残りを打ち切らない。
 *  - **参照集合が「不明」なときは掃除しない**。永続 JSON が存在しないことは
 *    「参照ゼロ」ではない。初回起動と、localStorage だけが消えた状態
 *    （サイトデータ削除 / Desktop の WebView プロファイルリセット。バイナリ側の
 *    IndexedDB / appDataDir とは独立に消えうる）は区別できないため、
 *    ここで全走査掃除をするとユーザの画像・変換済み ogg を復旧不能に巻き添えにする。
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
// setItem の直列化キュー（最新値のみ・latest-wins）＋ 間引き（先頭即時＋最小間隔）
// ---------------------------------------------------------------------------

let queuedValue: StorageValue<PersistedWallStore> | null = null;
let flushing = false;
/** 失敗トーストの連発防止。成功で解除し、次の失敗でまた 1 回だけ出す。 */
let failureNotified = false;

/**
 * 書き込みの最小間隔（ms）。バーストは「先頭で 1 回 → 以降この間隔ごとに 1 回」に畳む。
 *
 * 純粋な trailing debounce にしないのは、入力が途切れない限り書き込みが無期限に
 * 先送りされ、「未書き込みの最新値を抱えたまま落ちる」窓が青天井になるため。
 * 先頭即時なら、画像 D&D や ogg 変換のような「静止状態からの単発更新」は従来どおり
 * その場で永続化される（＝離脱時に新規 `storage.put` を伴う書き込みを始めてしまい、
 * 非同期チェーンが完走せず丸ごと失う、という経路を作らない）。
 */
const PERSIST_THROTTLE_MS = 400;

/** removeItem（全消し）の世代。実行中の書き込みが消去後に復活するのを防ぐ番兵。 */
let clearSeq = 0;

/** クールダウンタイマ。非 null = 直近に書き込み済み（バースト継続中）。 */
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
/** クールダウン中に積まれた未書き込みの値の storage キー名（null = 保留無し）。 */
let pendingName: string | null = null;

async function ensureFlushing(name: string): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queuedValue) {
      const value = queuedValue;
      queuedValue = null;
      const gen = clearSeq;
      try {
        const storage = await getBinaryStorage();
        const wall = await extractBinariesToRefs(value.state.wall, storage);
        if (gen !== clearSeq) {
          // 変換中に removeItem（全消し）が割り込んだ。ここで書くと消したはずの
          // JSON が復活し、実体を消したバイナリへの dangling ref が残る。値を捨てる。
          continue;
        }
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
    // ここは「取りこぼしを書き切る」ための保険なので間引きを挟まない
    // （挟むと queuedValue が誰にも書かれないまま残る窓ができる）。
    if (queuedValue) void ensureFlushing(name);
  }
}

/**
 * 書き込み要求を間引きに載せる。
 * 静止状態からの 1 発目はその場で書き、以後 {@link PERSIST_THROTTLE_MS} の間に来た
 * 更新は `queuedValue`（常に最新値）に畳まれ、クールダウン明けに 1 回だけ書かれる。
 */
function scheduleFlush(name: string): void {
  if (cooldownTimer === null) {
    startCooldown();
    void ensureFlushing(name);
    return;
  }
  pendingName = name;
}

/** クールダウン開始。明けた時点で保留があれば書き、無ければバースト終了とみなす。 */
function startCooldown(): void {
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    const name = pendingName;
    if (name === null) return;
    pendingName = null;
    startCooldown();
    void ensureFlushing(name);
  }, PERSIST_THROTTLE_MS);
}

/** 保留中の書き込みをクールダウンを待たずに開始する。保留が無ければ何もしない。 */
function dispatchFlush(): void {
  const name = pendingName;
  if (name === null) return;
  pendingName = null;
  // 操作の区切りなので、次の更新はまた即書きでよい＝クールダウンは張り直さない。
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  void ensureFlushing(name);
}

/** 保留中の書き込みを破棄する（removeItem 用。キュー本体は呼び出し側で捨てる）。 */
function cancelPendingFlush(): void {
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  pendingName = null;
}

// 強制フラッシュ。クールダウン中の「まだ書いていない最新値」を抱えたまま
// 操作の区切り／離脱を迎えないようにする。dispatchFlush は保留が無ければ no-op。
if (typeof window !== 'undefined') {
  // ドラッグ終了。ストローク中に畳まれた最新値をここで確定させる。
  // window の capture フェーズで拾い、途中で伝播を止められても取りこぼさない。
  window.addEventListener('pointerup', dispatchFlush, true);
  window.addEventListener('pointercancel', dispatchFlush, true);
  // タブ切替 / 最小化 / バックグラウンド化。まだページは生きているので非同期の
  // 書き込みが完走できる、実質的に最も確実な永続化ポイント。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dispatchFlush();
  });
  // 離脱。ここから始めた書き込みは、新規 `storage.put` を含むと完走しないことが
  // ある（含まなければ全て microtask なので unload 前の checkpoint で書き切る）。
  // 先頭即時の間引きにしてあるのは、この経路に賭けなくて済むようにするため。
  // pagehide は beforeunload が発火しない環境（Safari/iOS・bfcache）の補完。
  // どちらも preventDefault しないので「このサイトを離れますか？」は出ない。
  window.addEventListener('beforeunload', dispatchFlush);
  window.addEventListener('pagehide', dispatchFlush);
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
        // 永続 JSON が「無い」は「参照が空」ではなく「参照が不明」。
        // 初回起動と、localStorage だけが消えた状態（ブラウザのサイトデータ削除、
        // Desktop の WebView プロファイルリセット）を区別できず、後者で掃除すると
        // IndexedDB / appDataDir に残るユーザの画像・変換済み ogg を復旧不能に消す。
        // よってここでは何も削除しない。残存バイナリは次の書き込み以降の増分 GC で
        // 参照が確定してから扱う（孤児が残り続けるコストより喪失回避を優先）。
        lastReferencedKeys = null;
        // 掃除はしないが、アダプタの動的 import だけは温めておく
        // （最初の書き込みが import 解決待ちで長くならないように）。
        void getBinaryStorage().catch(() => undefined);
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
    // 実際の書き込みは間引きに載せる（先頭は即時、以降はクールダウン明け）。
    scheduleFlush(name);
    return Promise.resolve();
  },

  async removeItem(name) {
    // 保留中の書き込みを破棄する。残すと削除直後に古い state が書き戻り、
    // 実体を消したバイナリへの dangling ref が復活する。
    // 世代を進めるのは、既に走っている書き込み（extractBinariesToRefs の途中）が
    // この後 localStorage を書き戻すのを止めるため（ensureFlushing 内で検査）。
    clearSeq++;
    cancelPendingFlush();
    queuedValue = null;
    localStorage.removeItem(name);
    lastReferencedKeys = null;
    // localStorage を消すだけではバイナリ（IndexedDB / appDataDir）が孤児として残る。
    // removeItem は `persist.clearStorage()`＝「全部消す」意図なので実体も回収する。
    // ここでは永続 JSON が既に無く readCurrentPersistedKeys が空集合を返すため、
    // 参照集合 ∅ の sweep がそのまま全キー削除になる。
    // （中断した書き込みが直後に put を完了させた分だけは keys() のスナップショットに
    //   載らず残り得るが、参照する JSON はもう無いので次回以降の全走査で回収される。）
    try {
      const storage = await getBinaryStorage();
      await sweepOrphanKeys(storage, new Set(), name);
    } catch (e) {
      console.warn(
        'wallStorePersistStorage: failed to purge binaries on removeItem',
        e,
      );
    }
  },
};
