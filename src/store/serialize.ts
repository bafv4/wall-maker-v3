/**
 * WallState 内の BinaryRef を inline ↔ ref に変換する純然たる walker。
 * 仕様: REWRITE_SPEC.md 第7.2章。
 *
 *  - **extractBinariesToRefs**: persist 直前に呼ぶ。inline バイトを `BinaryStorage` に書き込み、
 *    state 側を ref に置換した「JSON.stringify 可能な」WallState を返す。
 *  - **resolveBinariesToInline**: hydrate 直後に呼ぶ。ref を `BinaryStorage` から読み出し、
 *    state 側を inline に置換して返す。該当エントリ無しは warn して**安全側のフォールバック**:
 *      - `packInfo.icon` → `null`
 *      - background の image layer / lock 画像 / extra textures → そのエントリを削除
 *      - sounds の custom → `{ mode: 'default' }` に戻す
 *    state 全体は破壊しない（decision #5）。
 *
 * どちらの方向も storage の失敗は**フィールド単位**で落とす（walk 全体を reject しない）。
 * ストレージが部分的に壊れていても、バイナリ以外の設定の保存・復元は継続させるため。
 *
 * ただし**フィールド単位で落としたことは黙らせない**。復元方向の欠落は
 * `BinaryRestoreReport` に集計し、hydrate 完了後に UI が `takeBinaryRestoreReport()` で
 * 1 回だけ回収してトーストで通知する（console 警告は誰も見ない）。
 * 「未ロードの ref を残す」側の契約は `core/binaryFields.ts` の JSDoc を参照。
 */

import type { BinaryFieldKind } from '../core/binaryFields';
import {
  SOUND_EVENT_KEYS,
  type BackgroundLayer,
  type BinaryRef,
  type LockImage,
  type SoundEntry,
  type SoundEventKey,
  type WallState,
} from '../core/state';
import type { BinaryStorage } from './storage/types';

// ---------------------------------------------------------------------------
// 単発 BinaryRef の変換
// ---------------------------------------------------------------------------

/**
 * 書き込み済みバイト列 → storageKey の対応表。
 * zustand persist は state 変更ごとに setItem を呼ぶため、ここで同一バイト列
 * （オブジェクト同一性）の再書き込みを抑止しないと、ドラッグ操作のたびに
 * 全バイナリが新キーで再アップロードされ IndexedDB が無制限に肥大化する。
 * hydrate 時（refToInline）にも記録し、復元後の再永続化で同じキーを使い回す。
 * WeakMap なのでバイト列が state から消えれば対応も自然に消える。
 */
const persistedKeyByBytes = new WeakMap<Uint8Array, string>();

/**
 * GC で削除済みのキー集合。WeakMap には「バイト列 → 削除済みキー」の対応が残り得る
 * （state から外れて GC された後、同じバイト列オブジェクトが state に戻るケース）。
 * その場合は再アップロードしないと dangling ref を永続化してしまうため、
 * GC 側（persistAdapter）が削除を通知し、こちらで復活を検知する。
 */
const deletedKeys = new Set<string>();

/** persistAdapter の GC がキー削除後に呼ぶ。 */
export function noteBinaryKeyDeleted(key: string): void {
  deletedKeys.add(key);
}

// ---------------------------------------------------------------------------
// 復元時の欠落レポート
// 「アプリを開き直したら背景画像とカスタム音が消えていた」を無通知にしないための集計。
// ---------------------------------------------------------------------------

/** 種別ごとの件数。0 件の種別はキーごと持たない。 */
export type BinaryFieldCounts = Partial<Record<BinaryFieldKind, number>>;

export interface BinaryRestoreReport {
  /** 実体が本当に無く、フィールドごと state から落としたもの（＝復元不能）。 */
  missing: BinaryFieldCounts;
  /** 読み出しに失敗し、未ロードの ref として残したもの（＝次回起動で復元され得る）。 */
  unresolved: BinaryFieldCounts;
}

function emptyReport(): BinaryRestoreReport {
  return { missing: {}, unresolved: {} };
}

let restoreReport: BinaryRestoreReport = emptyReport();

function countField(bucket: BinaryFieldCounts, field: BinaryFieldKind): void {
  bucket[field] = (bucket[field] ?? 0) + 1;
}

function reportTotal(report: BinaryRestoreReport): number {
  const sum = (b: BinaryFieldCounts): number =>
    Object.values(b).reduce<number>((a, n) => a + n, 0);
  return sum(report.missing) + sum(report.unresolved);
}

/**
 * hydrate 完了後に UI が 1 回だけ呼ぶ。欠落が無ければ `null`。
 * 読み出すと集計はクリアされる（StrictMode の二重 effect でも通知は 1 回）。
 */
export function takeBinaryRestoreReport(): BinaryRestoreReport | null {
  if (reportTotal(restoreReport) === 0) return null;
  const taken = restoreReport;
  restoreReport = emptyReport();
  return taken;
}

async function inlineToRef(
  ref: BinaryRef,
  storage: BinaryStorage,
): Promise<BinaryRef | null> {
  if (ref.kind === 'ref') return ref;
  const known = persistedKeyByBytes.get(ref.bytes);
  if (known && !deletedKeys.has(known)) {
    return { kind: 'ref', storageKey: known, mimeType: ref.mimeType };
  }
  const key = crypto.randomUUID();
  try {
    await storage.put(key, ref.bytes);
  } catch (e) {
    // put 失敗でこのフィールドだけ永続化から落とす（in-memory state は無傷）。
    // ここで reject すると walk 全体が失敗し、バイナリと無関係な設定まで
    // 一切保存されなくなるため、フィールド単位の縮退にとどめる。
    console.warn(
      `serialize: BinaryStorage.put failed for new key "${key}" — dropping field from persisted copy`,
      e,
    );
    return null;
  }
  persistedKeyByBytes.set(ref.bytes, key);
  return { kind: 'ref', storageKey: key, mimeType: ref.mimeType };
}

async function refToInline(
  ref: BinaryRef,
  storage: BinaryStorage,
  field: BinaryFieldKind,
): Promise<BinaryRef | null> {
  if (ref.kind === 'inline') return ref;
  let bytes: Uint8Array | null;
  try {
    bytes = await storage.get(ref.storageKey);
  } catch (e) {
    // 読み出しの**失敗**（一時的な I/O エラー等）は「実体は無傷かもしれない」ので
    // フィールドを落とさず ref のまま残す。ref は次回以降の永続化でもそのまま
    // 引き継がれ（inlineToRef の先頭分岐）、GC からも参照済みとして保護される。
    // 次回の正常な起動で実体から復元される。UI はこのフィールドを未ロードとして扱う
    // （表示はスキップ／書き出しは中止。契約は core/binaryFields.ts）。
    console.warn(
      `serialize: BinaryStorage.get failed for key "${ref.storageKey}" — keeping unresolved ref`,
      e,
    );
    countField(restoreReport.unresolved, field);
    return ref;
  }
  if (!bytes) {
    // エントリ不在（get は成功）＝実体が本当に無い。ここだけフィールドを落とす。
    console.warn(
      `serialize: missing BinaryStorage entry for key "${ref.storageKey}" — dropping field`,
    );
    countField(restoreReport.missing, field);
    return null;
  }
  // 復元したバイト列は既に storageKey を持つ。次回の永続化で再アップロードしない。
  persistedKeyByBytes.set(bytes, ref.storageKey);
  return { kind: 'inline', bytes, mimeType: ref.mimeType };
}

// ---------------------------------------------------------------------------
// 共通 walker（方向で挙動が分岐するため transform 関数を受け取る形）
// ---------------------------------------------------------------------------

/**
 * `field` は欠落レポートの集計単位（種別）。walk 側が「今どのフィールドを変換しているか」を
 * 知っている唯一の場所なので、ここで渡す。
 */
type Transform = (
  ref: BinaryRef,
  field: BinaryFieldKind,
) => Promise<BinaryRef | null>;

async function walkState(
  state: WallState,
  transform: Transform,
): Promise<WallState> {
  // packInfo.icon
  let icon = state.packInfo.icon;
  if (icon) {
    icon = await transform(icon, 'packIcon');
  }

  // background.layers（image レイヤのみ source を持つ）
  const layersRaw = await Promise.all(
    state.background.layers.map(async (l): Promise<BackgroundLayer | null> => {
      if (l.type !== 'image') return l;
      const source = await transform(l.source, 'backgroundImage');
      if (!source) return null;
      return { ...l, source };
    }),
  );
  const layers = layersRaw.filter((l): l is BackgroundLayer => l !== null);

  // extraTextures
  const extras: WallState['extraTextures'] = {};
  if (state.extraTextures.overlay) {
    const r = await transform(state.extraTextures.overlay, 'extraTexture');
    if (r) extras.overlay = r;
  }
  if (state.extraTextures.instance_background) {
    const r = await transform(
      state.extraTextures.instance_background,
      'extraTexture',
    );
    if (r) extras.instance_background = r;
  }
  if (state.extraTextures.instance_overlay) {
    const r = await transform(
      state.extraTextures.instance_overlay,
      'extraTexture',
    );
    if (r) extras.instance_overlay = r;
  }

  // lockImages.images
  const imagesRaw = await Promise.all(
    state.lockImages.images.map(async (img): Promise<LockImage | null> => {
      const source = await transform(img.source, 'lockImage');
      if (!source) return null;
      return { ...img, source };
    }),
  );
  const images = imagesRaw.filter((i): i is LockImage => i !== null);

  // sounds.events（mode=custom のみ ogg を持つ）
  const events = {} as Record<SoundEventKey, SoundEntry>;
  for (const key of SOUND_EVENT_KEYS) {
    const entry = state.sounds.events[key];
    if (entry.mode !== 'custom') {
      events[key] = entry;
      continue;
    }
    const ogg = await transform(entry.ogg, 'sound');
    if (!ogg) {
      events[key] = { mode: 'default' };
    } else {
      events[key] = { mode: 'custom', ogg, originalFileName: entry.originalFileName };
    }
  }

  return {
    ...state,
    packInfo: { ...state.packInfo, icon },
    background: { layers },
    extraTextures: extras,
    lockImages: { ...state.lockImages, images },
    sounds: { ...state.sounds, events },
  };
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

export function extractBinariesToRefs(
  state: WallState,
  storage: BinaryStorage,
): Promise<WallState> {
  return walkState(state, (ref) => inlineToRef(ref, storage));
}

export async function resolveBinariesToInline(
  state: WallState,
  storage: BinaryStorage,
): Promise<WallState> {
  // 1 回の復元＝1 回の通知。前回分の集計を持ち越さない。
  restoreReport = emptyReport();
  try {
    return await walkState(state, (ref, field) =>
      refToInline(ref, storage, field),
    );
  } catch (e) {
    // walk 自体が落ちたときは呼び出し側（persistAdapter）が state 全体を捨てて
    // 既定 state で起動する。途中まで数えた欠落を残すと「一部だけ失われた」と
    // 誤解させるので集計ごと捨てる（全体の失敗は restoreFailed が通知する）。
    restoreReport = emptyReport();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GC（state 内のキー集合を返す）
// 「state から参照されないキー」を BinaryStorage から掃除する用。
// ---------------------------------------------------------------------------

export function collectReferencedKeys(state: WallState): Set<string> {
  const keys = new Set<string>();
  const visit = (ref: BinaryRef | null | undefined): void => {
    if (ref && ref.kind === 'ref') keys.add(ref.storageKey);
  };

  visit(state.packInfo.icon);
  for (const layer of state.background.layers) {
    if (layer.type === 'image') visit(layer.source);
  }
  visit(state.extraTextures.overlay);
  visit(state.extraTextures.instance_background);
  visit(state.extraTextures.instance_overlay);
  for (const img of state.lockImages.images) {
    visit(img.source);
  }
  for (const key of SOUND_EVENT_KEYS) {
    const entry = state.sounds.events[key];
    if (entry.mode === 'custom') visit(entry.ogg);
  }
  return keys;
}
