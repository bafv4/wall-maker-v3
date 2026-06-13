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
 */

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

async function inlineToRef(
  ref: BinaryRef,
  storage: BinaryStorage,
): Promise<BinaryRef> {
  if (ref.kind === 'ref') return ref;
  const key = crypto.randomUUID();
  await storage.put(key, ref.bytes);
  return { kind: 'ref', storageKey: key, mimeType: ref.mimeType };
}

async function refToInline(
  ref: BinaryRef,
  storage: BinaryStorage,
): Promise<BinaryRef | null> {
  if (ref.kind === 'inline') return ref;
  const bytes = await storage.get(ref.storageKey);
  if (!bytes) {
    console.warn(
      `serialize: missing BinaryStorage entry for key "${ref.storageKey}" — dropping field`,
    );
    return null;
  }
  return { kind: 'inline', bytes, mimeType: ref.mimeType };
}

// ---------------------------------------------------------------------------
// 共通 walker（方向で挙動が分岐するため transform 関数を受け取る形）
// ---------------------------------------------------------------------------

type Transform = (ref: BinaryRef) => Promise<BinaryRef | null>;

async function walkState(
  state: WallState,
  transform: Transform,
): Promise<WallState> {
  // packInfo.icon
  let icon = state.packInfo.icon;
  if (icon) {
    icon = await transform(icon);
  }

  // background.layers（image レイヤのみ source を持つ）
  const layersRaw = await Promise.all(
    state.background.layers.map(async (l): Promise<BackgroundLayer | null> => {
      if (l.type !== 'image') return l;
      const source = await transform(l.source);
      if (!source) return null;
      return { ...l, source };
    }),
  );
  const layers = layersRaw.filter((l): l is BackgroundLayer => l !== null);

  // extraTextures
  const extras: WallState['extraTextures'] = {};
  if (state.extraTextures.overlay) {
    const r = await transform(state.extraTextures.overlay);
    if (r) extras.overlay = r;
  }
  if (state.extraTextures.instance_background) {
    const r = await transform(state.extraTextures.instance_background);
    if (r) extras.instance_background = r;
  }
  if (state.extraTextures.instance_overlay) {
    const r = await transform(state.extraTextures.instance_overlay);
    if (r) extras.instance_overlay = r;
  }

  // lockImages.images
  const imagesRaw = await Promise.all(
    state.lockImages.images.map(async (img): Promise<LockImage | null> => {
      const source = await transform(img.source);
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
    const ogg = await transform(entry.ogg);
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

export function resolveBinariesToInline(
  state: WallState,
  storage: BinaryStorage,
): Promise<WallState> {
  return walkState(state, (ref) => refToInline(ref, storage));
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
