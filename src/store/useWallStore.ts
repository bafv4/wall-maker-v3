/**
 * Zustand 5 + persist。ドメイン state は WallState、永続化は persistAdapter（軽い state→localStorage、
 * バイナリ→IndexedDB）。UI state は今は持たないが、将来追加するため `partialize` で WallState のみ persist する。
 *
 * 仕様: REWRITE_SPEC.md 第7.2章。
 *
 * 不変条件:
 *  - 座標は floor 済みであること（coords.ts）。state 反映するアクションは座標を Math.floor で整数化する。
 *  - rows/columns は 1 以上の整数（後続バリデーション層で担保。アクションでも最低限の正規化を行う）。
 *  - 解像度変更は `scaleStateForResolution` を必ず通す（背景レイヤと layout を同時にスケール、第8章 #9）。
 *  - import は浅いマージせず WallState を丸ごと差し替える（第8章 #6）。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  floorArea,
  floorInt,
  scaleStateForResolution,
} from '../core/coords';
import {
  createDefaultWallState,
  type Area,
  type BackgroundLayer,
  type ColorLayer,
  type GradientLayer,
  type ImageLayer,
  type LockImage,
  type MainArea,
  type PackInfo,
  type Resolution,
  type SoundEntry,
  type SoundEventKey,
  type SoundSettings,
  type VisibleArea,
  type WallState,
} from '../core/state';
import {
  wallStorePersistStorage,
  type PersistedWallStore,
} from './persistAdapter';

// ---------------------------------------------------------------------------
// 判別共用体に対する型安全なパッチ
// ---------------------------------------------------------------------------

export type BackgroundLayerPatch =
  | ({ type: 'color' } & Partial<Omit<ColorLayer, 'id' | 'type'>>)
  | ({ type: 'image' } & Partial<Omit<ImageLayer, 'id' | 'type'>>)
  | ({ type: 'gradient' } & Partial<Omit<GradientLayer, 'id' | 'type'>>);

export type ExtraTextureSlot =
  | 'overlay'
  | 'instance_background'
  | 'instance_overlay';

// ---------------------------------------------------------------------------
// ストア定義
// ---------------------------------------------------------------------------

/**
 * UI state — 永続化対象外（partialize で除外）。
 * 現状は背景レイヤの選択 ID のみ。後続 Phase でツール選択・モーダル状態などを追加可能。
 */
export interface UIState {
  selectedBackgroundLayerId: string | null;
}

export interface WallStoreState {
  wall: WallState;
  ui: UIState;

  // --- 全体 ---
  reset: () => void;
  replaceWallState: (next: WallState) => void;

  // --- UI ---
  selectBackgroundLayer: (id: string | null) => void;

  // --- 解像度 / 全体スケール ---
  setResolution: (r: Resolution) => void;

  // --- pack info / 旗 ---
  setPackInfo: (patch: Partial<PackInfo>) => void;
  setReplaceLockedInstances: (b: boolean) => void;

  // --- layout ---
  /** main / locked / preparing を一括置換（レイアウトプリセット適用など）。 */
  applyLayout: (layout: WallState['layout']) => void;
  setMain: (patch: Partial<MainArea>) => void;
  setLocked: (patch: Partial<VisibleArea>) => void;
  setLockedShow: (show: boolean) => void;
  addPreparing: (area?: VisibleArea) => void;
  removePreparing: (index: number) => void;
  updatePreparing: (index: number, patch: Partial<VisibleArea>) => void;

  // --- background ---
  addBackgroundLayer: (layer: BackgroundLayer) => void;
  removeBackgroundLayer: (id: string) => void;
  updateBackgroundLayer: (id: string, patch: BackgroundLayerPatch) => void;
  reorderBackgroundLayers: (ids: string[]) => void;

  // --- extra textures ---
  setExtraTexture: (
    slot: ExtraTextureSlot,
    ref: WallState['extraTextures'][ExtraTextureSlot] | null,
  ) => void;

  // --- lock images ---
  setLockEnabled: (b: boolean) => void;
  addLockImage: (img: LockImage) => void;
  removeLockImage: (id: string) => void;
  reorderLockImages: (ids: string[]) => void;

  // --- sounds ---
  setSoundGlobalMode: (mode: SoundSettings['globalMode']) => void;
  setSoundResetUnified: (b: boolean) => void;
  setSoundEvent: (key: SoundEventKey, entry: SoundEntry) => void;
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** 座標 patch を Area に当てて floor。rows/columns/padding も整数化する。 */
function mergeAreaPatch<T extends Area>(area: T, patch: Partial<T>): T {
  const merged: T = { ...area, ...patch };
  if (patch.rows !== undefined) merged.rows = Math.max(1, floorInt(patch.rows));
  if (patch.columns !== undefined)
    merged.columns = Math.max(1, floorInt(patch.columns));
  return floorArea(merged);
}

/** 既存レイヤと同じ判別子のみマージできるよう型安全に適用。種別不一致は no-op。 */
function applyLayerPatch(
  layer: BackgroundLayer,
  patch: BackgroundLayerPatch,
): BackgroundLayer {
  if (layer.type !== patch.type) {
    console.warn(
      `updateBackgroundLayer: type mismatch (layer=${layer.type}, patch=${patch.type}) — ignored`,
    );
    return layer;
  }
  switch (patch.type) {
    case 'color': {
      // layer.type === 'color' は narrowing 済
      return { ...(layer as ColorLayer), ...patch };
    }
    case 'image': {
      return { ...(layer as ImageLayer), ...patch };
    }
    case 'gradient': {
      return { ...(layer as GradientLayer), ...patch };
    }
  }
}

function blankPreparing(state: WallState): VisibleArea {
  // main 領域に重なる小さなデフォルトを採用。ユーザは UI で動かす想定。
  return floorArea({
    x: state.layout.main.x,
    y: state.layout.main.y,
    width: Math.max(1, Math.floor(state.layout.main.width / 4)),
    height: Math.max(1, Math.floor(state.layout.main.height / 4)),
    rows: 1,
    columns: 1,
    useGrid: true,
    padding: 0,
    show: true,
  });
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export const useWallStore = create<WallStoreState>()(
  persist(
    (set) => ({
      wall: createDefaultWallState(),
      ui: { selectedBackgroundLayerId: null },

      reset: () =>
        set({
          wall: createDefaultWallState(),
          ui: { selectedBackgroundLayerId: null },
        }),

      replaceWallState: (next) => set({ wall: next }),

      selectBackgroundLayer: (id) =>
        set((s) => ({ ui: { ...s.ui, selectedBackgroundLayerId: id } })),

      setResolution: (r) =>
        set((s) => ({
          wall: scaleStateForResolution(s.wall, s.wall.resolution, {
            width: Math.max(1, floorInt(r.width)),
            height: Math.max(1, floorInt(r.height)),
          }),
        })),

      setPackInfo: (patch) =>
        set((s) => ({
          wall: { ...s.wall, packInfo: { ...s.wall.packInfo, ...patch } },
        })),

      setReplaceLockedInstances: (b) =>
        set((s) => ({ wall: { ...s.wall, replaceLockedInstances: b } })),

      applyLayout: (layout) =>
        set((s) => ({
          wall: {
            ...s.wall,
            // 受け取ったレイアウトを丸ごと置換。座標は念のため floor 整数化する
            // （プリセット側で整数化済みだが、不変条件を境界で必ず保証する）。
            layout: {
              main: floorArea(layout.main),
              locked: floorArea(layout.locked),
              preparing: layout.preparing.map((p) => floorArea(p)),
            },
          },
        })),

      setMain: (patch) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              main: mergeAreaPatch(s.wall.layout.main, patch),
            },
          },
        })),

      setLocked: (patch) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              locked: mergeAreaPatch(s.wall.layout.locked, patch),
            },
          },
        })),

      setLockedShow: (show) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              locked: { ...s.wall.layout.locked, show },
            },
          },
        })),

      addPreparing: (area) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              preparing: [
                ...s.wall.layout.preparing,
                area ?? blankPreparing(s.wall),
              ],
            },
          },
        })),

      removePreparing: (index) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              preparing: s.wall.layout.preparing.filter((_, i) => i !== index),
            },
          },
        })),

      updatePreparing: (index, patch) =>
        set((s) => ({
          wall: {
            ...s.wall,
            layout: {
              ...s.wall.layout,
              preparing: s.wall.layout.preparing.map((p, i) =>
                i === index ? mergeAreaPatch(p, patch) : p,
              ),
            },
          },
        })),

      addBackgroundLayer: (layer) =>
        set((s) => ({
          wall: {
            ...s.wall,
            background: {
              layers: [...s.wall.background.layers, layer],
            },
          },
        })),

      removeBackgroundLayer: (id) =>
        set((s) => ({
          wall: {
            ...s.wall,
            background: {
              layers: s.wall.background.layers.filter((l) => l.id !== id),
            },
          },
          ui:
            s.ui.selectedBackgroundLayerId === id
              ? { ...s.ui, selectedBackgroundLayerId: null }
              : s.ui,
        })),

      updateBackgroundLayer: (id, patch) =>
        set((s) => ({
          wall: {
            ...s.wall,
            background: {
              layers: s.wall.background.layers.map((l) =>
                l.id === id ? applyLayerPatch(l, patch) : l,
              ),
            },
          },
        })),

      reorderBackgroundLayers: (ids) =>
        set((s) => {
          const map = new Map(s.wall.background.layers.map((l) => [l.id, l]));
          const ordered: BackgroundLayer[] = [];
          for (const id of ids) {
            const l = map.get(id);
            if (l) ordered.push(l);
          }
          // 並び替え対象に含まれていなかったレイヤは末尾に残す（破壊回避）
          for (const l of s.wall.background.layers) {
            if (!ids.includes(l.id)) ordered.push(l);
          }
          return { wall: { ...s.wall, background: { layers: ordered } } };
        }),

      setExtraTexture: (slot, ref) =>
        set((s) => {
          const next = { ...s.wall.extraTextures };
          if (ref === null) {
            delete next[slot];
          } else {
            next[slot] = ref;
          }
          return { wall: { ...s.wall, extraTextures: next } };
        }),

      setLockEnabled: (b) =>
        set((s) => ({
          wall: {
            ...s.wall,
            lockImages: { ...s.wall.lockImages, enabled: b },
          },
        })),

      addLockImage: (img) =>
        set((s) => ({
          wall: {
            ...s.wall,
            lockImages: {
              ...s.wall.lockImages,
              images: [...s.wall.lockImages.images, img],
            },
          },
        })),

      removeLockImage: (id) =>
        set((s) => ({
          wall: {
            ...s.wall,
            lockImages: {
              ...s.wall.lockImages,
              images: s.wall.lockImages.images.filter((i) => i.id !== id),
            },
          },
        })),

      reorderLockImages: (ids) =>
        set((s) => {
          const map = new Map(s.wall.lockImages.images.map((i) => [i.id, i]));
          const ordered: LockImage[] = [];
          for (const id of ids) {
            const i = map.get(id);
            if (i) ordered.push(i);
          }
          for (const i of s.wall.lockImages.images) {
            if (!ids.includes(i.id)) ordered.push(i);
          }
          return {
            wall: {
              ...s.wall,
              lockImages: { ...s.wall.lockImages, images: ordered },
            },
          };
        }),

      setSoundGlobalMode: (mode) =>
        set((s) => ({
          wall: { ...s.wall, sounds: { ...s.wall.sounds, globalMode: mode } },
        })),

      setSoundResetUnified: (b) =>
        set((s) => ({
          wall: {
            ...s.wall,
            sounds: { ...s.wall.sounds, resetUnified: b },
          },
        })),

      setSoundEvent: (key, entry) =>
        set((s) => ({
          wall: {
            ...s.wall,
            sounds: {
              ...s.wall.sounds,
              events: { ...s.wall.sounds.events, [key]: entry },
            },
          },
        })),
    }),
    {
      name: 'wall-store',
      version: 1,
      storage: wallStorePersistStorage,
      partialize: (s): PersistedWallStore => ({ wall: s.wall }),
    },
  ),
);
