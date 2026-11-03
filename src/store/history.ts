/**
 * history — 編集内容（`wall`）の取り消し / やり直し。
 *
 * `useWallStore` を購読し、`wall` が差し替わるたびに直前の `wall` を履歴に積む。
 * WallState はイミュータブルに更新される（変更のない部分は同じ参照を共有する）ので、
 * 履歴は参照を持つだけで済む。永続化はしない（ウィンドウを閉じれば消える）。
 * 取り消しで戻った画像・音声は、GC 済みでも次の永続化で書き直される（serialize.ts の deletedKeys）。
 *
 * 1 手のまとめ方:
 *  - ドラッグや連続入力を 1 手にする。同じ種類（変わった最上位キーの組）の変更が、
 *    ポインタを押している間、または COALESCE_MS 以内に続いたら直前の 1 手にまとめる。
 *  - ポインタを押した時点で区切る（クリックやドラッグの開始ごとに新しい 1 手）。
 *  - 要素の追加・削除（配列の件数が変わる変更）は前後とまとめない。
 *    「削除しました — 元に戻す」が削除だけを戻すようにするため。
 *  - 中身が変わらない差し替え（blur 時の同値の確定など）は積まない。押しても何も起きない
 *    取り消しが挟まらないように。
 *
 * 記録しないもの: hydrate（復元）による差し替え、取り消し / やり直し自身の適用。
 * インポートは `clearHistory` で履歴を捨てる（useFileOperations 参照）。
 */

import { create } from 'zustand';
import i18n from '../i18n';
import { toast } from '../components/ui/Toast';
import type { WallState } from '../core/state';
import {
  DEFAULT_AREA_SELECTION,
  useWallStore,
  type UIState,
} from './useWallStore';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 500;

interface HistoryState {
  past: readonly WallState[];
  future: readonly WallState[];
}

export const useHistoryStore = create<HistoryState>()(() => ({
  past: [],
  future: [],
}));

/** 取り消し / やり直しの適用中（購読側で記録しない）。 */
let applying = false;
/** 直前に記録した変更の種類。null なら次の変更は必ず新しい 1 手になる。 */
let lastKind: string | null = null;
let lastAt = 0;
let pointerHeld = false;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      pointerHeld = true;
      lastKind = null;
    },
    true,
  );
  const release = () => {
    pointerHeld = false;
    lastAt = performance.now();
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  // ウィンドウ外で離すと pointerup が届かないことがある
  window.addEventListener('blur', release);
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** 構造的に等しいか。バイト列は参照で比べる（同じ中身の別ファイルも変更として扱う）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    ArrayBuffer.isView(a) ||
    ArrayBuffer.isView(b) ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) =>
    sameValue(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/** 変更の種類。要素の増減は null（前後とまとめない）。 */
function changeKind(prev: WallState, next: WallState): string | null {
  if (
    prev.background.layers.length !== next.background.layers.length ||
    prev.lockImages.images.length !== next.lockImages.images.length ||
    prev.layout.preparing.length !== next.layout.preparing.length
  ) {
    return null;
  }
  return (Object.keys(next) as (keyof WallState)[])
    .filter((k) => prev[k] !== next[k])
    .join(',');
}

useWallStore.subscribe((state, prev) => {
  if (state.wall === prev.wall || applying) return;
  // hydrate の差し替えは hasHydrated が true になる前に走る（zustand persist）
  if (!useWallStore.persist.hasHydrated()) return;
  if (sameValue(prev.wall, state.wall)) return;

  const now = performance.now();
  const kind = changeKind(prev.wall, state.wall);
  const merge =
    kind !== null &&
    kind === lastKind &&
    (pointerHeld || now - lastAt < COALESCE_MS);
  lastKind = kind;
  lastAt = now;
  // まとめる場合、直前の 1 手が既に変更前の wall を持っている（future もその時点で空）
  if (merge) return;

  const { past } = useHistoryStore.getState();
  useHistoryStore.setState({
    past: [...past, prev.wall].slice(-HISTORY_LIMIT),
    future: [],
  });
});

/**
 * 戻した wall に存在しない対象を選択から外す（削除の取り消しの取り消し等で、
 * 消えたレイヤ・preparing を指したままにしない）。
 */
function reconcileSelection(ui: UIState, wall: WallState): UIState {
  const layerId = ui.selectedBackgroundLayerId;
  const layerOk =
    layerId === null || wall.background.layers.some((l) => l.id === layerId);
  const areas = ui.selectedAreas.filter(
    (t) => t.kind !== 'preparing' || t.index < wall.layout.preparing.length,
  );
  if (layerOk && areas.length === ui.selectedAreas.length) return ui;
  return {
    selectedBackgroundLayerId: layerOk ? layerId : null,
    selectedAreas: areas.length > 0 ? areas : DEFAULT_AREA_SELECTION,
  };
}

function applyWall(wall: WallState): void {
  applying = true;
  try {
    useWallStore.setState((s) => ({
      wall,
      ui: reconcileSelection(s.ui, wall),
    }));
  } finally {
    applying = false;
  }
  lastKind = null;
}

export function undo(): void {
  const { past, future } = useHistoryStore.getState();
  const target = last(past);
  if (!target) return;
  useHistoryStore.setState({
    past: past.slice(0, -1),
    future: [...future, useWallStore.getState().wall],
  });
  applyWall(target);
}

export function redo(): void {
  const { past, future } = useHistoryStore.getState();
  const target = last(future);
  if (!target) return;
  useHistoryStore.setState({
    past: [...past, useWallStore.getState().wall].slice(-HISTORY_LIMIT),
    future: future.slice(0, -1),
  });
  applyWall(target);
}

export function clearHistory(): void {
  useHistoryStore.setState({ past: [], future: [] });
  lastKind = null;
}

/**
 * 「〜しました」に「元に戻す」を添えたトーストを出す。削除などの変更の直後に呼ぶ。
 * 戻すのはその 1 手だけ。以降に別の変更や取り消し / やり直しがあればトーストを閉じる
 * （押したときに後から行った別の変更を戻してしまわないように）。
 */
export function notifyUndoable(message: string): void {
  const step = last(useHistoryStore.getState().past);
  if (!step) {
    toast.info(message);
    return;
  }
  const isLatest = () => last(useHistoryStore.getState().past) === step;
  const id = toast.info(message, {
    action: {
      label: i18n.t('history.undo'),
      onClick: () => {
        if (isLatest()) undo();
      },
    },
  });
  const unsubscribe = useHistoryStore.subscribe(() => {
    if (isLatest()) return;
    toast.dismiss(id);
    unsubscribe();
  });
}
