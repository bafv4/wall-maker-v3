/**
 * Zustand 5 + persist。ドメイン state は WallState、永続化は persistAdapter（軽い state→localStorage、
 * バイナリ→IndexedDB）。UI state は今は持たないが、将来追加するため `partialize` で WallState のみ persist する。
 *
 * 仕様: REWRITE_SPEC.md 第7.2章。
 *
 * 不変条件:
 *  - 幾何（x/y/width/height/rows/columns/padding）は `floorArea`/`floorCell`（coords.ts）が
 *    一箇所で担保する：整数化・非有限値の排除・width/height >= 1・rows/columns >= 1・padding >= 0。
 *    layout / 背景レイヤの transform に触るアクションは必ずどちらかを通すこと。
 *  - 解像度変更は `scaleStateForResolution` を必ず通す（背景レイヤと layout を同時にスケール、第8章 #9）。
 *  - import は浅いマージせず WallState を丸ごと差し替える（第8章 #6）。
 *  - hydrate 時は `normalizeWallStateNumbers` を通す。旧版で Infinity が混入した state は
 *    JSON 化で `x: null` として保存されており、通さないと永久に壊れたままになる。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  floorArea,
  floorCell,
  normalizeWallStateNumbers,
  scaleStateForResolution,
  toSafeInt,
} from '../core/coords';
import {
  DEFAULT_LOCK_WEIGHT,
  MAX_LOCK_WEIGHT,
} from '../core/lockWeights';
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
  validateWallState,
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
  /** 複数エリアの位置を 1 回の set() でまとめて更新する（複数選択ドラッグ用）。 */
  moveAreas: (moves: AreaMove[]) => void;

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
  /** lock 画像 1 枚の抽選重み。`undefined` で「既定重みに従う」に戻す。 */
  setLockImageWeight: (id: string, weight: number | undefined) => void;
  /** コレクション全体の既定重み（`lock.png.mcmeta` の `seedqueue.defaultWeight`）。 */
  setLockDefaultWeight: (weight: number) => void;

  // --- sounds ---
  setSoundGlobalMode: (mode: SoundSettings['globalMode']) => void;
  setSoundResetUnified: (b: boolean) => void;
  setSoundEvent: (key: SoundEventKey, entry: SoundEntry) => void;
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/**
 * `moveAreas` の 1 件分。プレビューでの複数選択ドラッグが、選択中の全エリアを
 * 1 回の set() でまとめて動かすために使う（エリアごとに setMain/setLocked/… を
 * 呼ぶと 1 pointermove あたり N 回の再レンダリング＋永続化が走ってしまう）。
 */
export type AreaMove =
  | { kind: 'main'; x: number; y: number }
  | { kind: 'locked'; x: number; y: number }
  | { kind: 'preparing'; index: number; x: number; y: number };

/**
 * 座標 patch を Area に当てて正規化する。
 * 整数化・非有限値の排除・最小サイズ 1・rows/columns >= 1 はすべて `floorArea`（coords.ts）が担保する。
 * UI 側のクランプが破れても壊れた値を state に入れないための最終防衛線。
 */
function mergeAreaPatch<T extends Area>(area: T, patch: Partial<T>): T {
  return floorArea({ ...area, ...patch });
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
      const merged: ImageLayer = { ...(layer as ImageLayer), ...patch };
      // transform は wall 座標系の幾何なので、エリアと同じ不変条件へ揃える
      // （UI 側の `Math.floor(Number(v) || 0)` は "1e999" → Infinity を通してしまう）。
      return merged.transform
        ? { ...merged, transform: floorCell(merged.transform) }
        : merged;
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

      // import など外部由来の state も幾何の不変条件へ引き戻してから採用する。
      replaceWallState: (next) => set({ wall: normalizeWallStateNumbers(next) }),

      selectBackgroundLayer: (id) =>
        set((s) => ({ ui: { ...s.ui, selectedBackgroundLayerId: id } })),

      // 非有限値（"1e999" → Infinity）が入ると sx/sy が Infinity になり layout 全体が壊れる。
      // toSafeInt で 1..MAX_DIMENSION の整数に落としてからスケールする。
      setResolution: (r) =>
        set((s) => ({
          wall: scaleStateForResolution(s.wall, s.wall.resolution, {
            width: toSafeInt(r.width, s.wall.resolution.width, 1),
            height: toSafeInt(r.height, s.wall.resolution.height, 1),
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
            // 受け取ったレイアウトを丸ごと置換。floorArea が整数化・非有限値の排除・
            // 最小サイズ 1・rows/columns >= 1 まで担保する（プリセット以外の呼び出し元が
            // 増えても不変条件が破れないよう、layout 系の入口では必ず通す）。
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
                // 外部から渡されたエリアも layout の入口で必ず正規化する。
                area ? floorArea(area) : blankPreparing(s.wall),
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

      moveAreas: (moves) =>
        set((s) => {
          let main = s.wall.layout.main;
          let locked = s.wall.layout.locked;
          let preparing: VisibleArea[] | null = null;
          for (const m of moves) {
            if (m.kind === 'main') {
              main = mergeAreaPatch(main, { x: m.x, y: m.y });
            } else if (m.kind === 'locked') {
              locked = mergeAreaPatch(locked, { x: m.x, y: m.y });
            } else {
              preparing ??= [...s.wall.layout.preparing];
              const cur = preparing[m.index];
              if (cur) {
                preparing[m.index] = mergeAreaPatch(cur, { x: m.x, y: m.y });
              }
            }
          }
          return {
            wall: {
              ...s.wall,
              layout: {
                ...s.wall.layout,
                main,
                locked,
                preparing: preparing ?? s.wall.layout.preparing,
              },
            },
          };
        }),

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
          // 採用済み id の Set。`ids.includes` をループ内で回すと O(n^2) になるうえ、
          // ids に重複があるとレイヤが二重に並ぶ。
          const taken = new Set<string>();
          for (const id of ids) {
            const l = map.get(id);
            if (l && !taken.has(id)) {
              taken.add(id);
              ordered.push(l);
            }
          }
          // 並び替え対象に含まれていなかったレイヤは末尾に残す（破壊回避）
          for (const l of s.wall.background.layers) {
            if (!taken.has(l.id)) ordered.push(l);
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
          // lock 画像は最大 255 枚（parsePack）。`ids.includes` の O(n^2) を避ける。
          const taken = new Set<string>();
          for (const id of ids) {
            const i = map.get(id);
            if (i && !taken.has(id)) {
              taken.add(id);
              ordered.push(i);
            }
          }
          for (const i of s.wall.lockImages.images) {
            if (!taken.has(i.id)) ordered.push(i);
          }
          return {
            wall: {
              ...s.wall,
              lockImages: { ...s.wall.lockImages, images: ordered },
            },
          };
        }),

      setLockImageWeight: (id, weight) =>
        set((s) => ({
          wall: {
            ...s.wall,
            lockImages: {
              ...s.wall.lockImages,
              images: s.wall.lockImages.images.map((img) => {
                if (img.id !== id) return img;
                if (weight === undefined) {
                  // 「既定重みに従う」＝ .mcmeta に weight を書かない状態に戻す。
                  const { weight: _drop, ...rest } = img;
                  return rest;
                }
                return {
                  ...img,
                  weight: toSafeInt(weight, DEFAULT_LOCK_WEIGHT, 1, MAX_LOCK_WEIGHT),
                };
              }),
            },
          },
        })),

      setLockDefaultWeight: (weight) =>
        set((s) => ({
          wall: {
            ...s.wall,
            lockImages: {
              ...s.wall.lockImages,
              defaultWeight: toSafeInt(
                weight,
                DEFAULT_LOCK_WEIGHT,
                1,
                MAX_LOCK_WEIGHT,
              ),
            },
          },
        })),

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
      // 旧バージョンで Infinity/NaN が混入した state は JSON 化で `x: null` として
      // 保存されており、通常操作では二度と直らない。hydrate 境界で数値を正規化して復旧させる。
      merge: (persisted, current) => {
        const wall = (persisted as Partial<PersistedWallStore> | undefined)
          ?.wall;
        if (!wall) return current;
        try {
          // 何をどう直したかを追えるよう、修復前に不正な箇所を列挙して警告する
          // （復元後は正規化済みのため、後から原因を特定できなくなる）。
          const issues = validateWallState(wall);
          if (issues.length > 0) {
            console.warn(
              'wall-store: 復元した state に不正な数値があるため正規化します',
              issues,
            );
          }
          return { ...current, wall: normalizeWallStateNumbers(wall) };
        } catch (e) {
          // 正規化に失敗しても復元済みの state は捨てない。既定 state に倒すと
          // 次の保存で localStorage が既定値で上書きされ、GC（persistAdapter）が
          // 参照されなくなった画像・音声バイナリまで消してしまう。
          console.error('wall-store: 復元した state の正規化に失敗しました', e);
          return { ...current, wall };
        }
      },
      // getItem は reject しない設計（persistAdapter 参照）だが、万一の hydration
      // エラーを黙殺させないための保険。未設定だと zustand は例外を握り潰す。
      onRehydrateStorage: () => (_state, error) => {
        if (error) console.error('wall-store: hydration failed', error);
      },
    },
  ),
);
