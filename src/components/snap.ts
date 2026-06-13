/**
 * スナップ計算（プレビュー上のドラッグ/リサイズで使用）。
 * 仕様: REWRITE_SPEC.md 第4.5章準拠（state 反映は floor で整数化される前提）。
 *
 *  - 候補値（candidatesX/Y）は他エリアの辺・中央線、キャンバスの辺・中央。real px。
 *  - 閾値（thresholdX/Y）は real px。プレビュー px 6 程度を呼び出し側で換算。
 *  - Shift で無効化したい場合は呼び出し側でスキップする。
 *  - 戻り値の cell はまだ整数化していない（呼び出し側の store action が floor する）。
 */

import type { AreaCell } from '../core/state';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface SnapCandidates {
  xs: number[];
  ys: number[];
}

export interface SnapResult {
  cell: AreaCell;
  hitX: number | null;
  hitY: number | null;
}

function findBest(
  candidates: number[],
  current: number,
  threshold: number,
): { delta: number; target: number } | null {
  let best: { delta: number; target: number } | null = null;
  for (const t of candidates) {
    const d = t - current;
    if (
      Math.abs(d) <= threshold &&
      (!best || Math.abs(d) < Math.abs(best.delta))
    ) {
      best = { delta: d, target: t };
    }
  }
  return best;
}

export function snapMove(
  cell: AreaCell,
  cand: SnapCandidates,
  thresholdX: number,
  thresholdY: number,
): SnapResult {
  // X 軸: 左辺・中央・右辺の 3 点
  const xPoints = [cell.x, cell.x + cell.width / 2, cell.x + cell.width];
  let bestX: { delta: number; target: number } | null = null;
  for (const px of xPoints) {
    const cand_ = findBest(cand.xs, px, thresholdX);
    if (cand_ && (!bestX || Math.abs(cand_.delta) < Math.abs(bestX.delta))) {
      bestX = cand_;
    }
  }
  const yPoints = [cell.y, cell.y + cell.height / 2, cell.y + cell.height];
  let bestY: { delta: number; target: number } | null = null;
  for (const py of yPoints) {
    const cand_ = findBest(cand.ys, py, thresholdY);
    if (cand_ && (!bestY || Math.abs(cand_.delta) < Math.abs(bestY.delta))) {
      bestY = cand_;
    }
  }
  return {
    cell: {
      ...cell,
      x: bestX ? cell.x + bestX.delta : cell.x,
      y: bestY ? cell.y + bestY.delta : cell.y,
    },
    hitX: bestX?.target ?? null,
    hitY: bestY?.target ?? null,
  };
}

export function snapResize(
  cell: AreaCell,
  handle: Handle,
  cand: SnapCandidates,
  thresholdX: number,
  thresholdY: number,
): SnapResult {
  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne';
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se';

  let nx = cell.x;
  let nw = cell.width;
  let hitX: number | null = null;
  if (movesLeft) {
    const best = findBest(cand.xs, cell.x, thresholdX);
    if (best) {
      nx = cell.x + best.delta;
      nw = cell.width - best.delta;
      hitX = best.target;
    }
  } else if (movesRight) {
    const best = findBest(cand.xs, cell.x + cell.width, thresholdX);
    if (best) {
      nw = cell.width + best.delta;
      hitX = best.target;
    }
  }

  let ny = cell.y;
  let nh = cell.height;
  let hitY: number | null = null;
  if (movesTop) {
    const best = findBest(cand.ys, cell.y, thresholdY);
    if (best) {
      ny = cell.y + best.delta;
      nh = cell.height - best.delta;
      hitY = best.target;
    }
  } else if (movesBottom) {
    const best = findBest(cand.ys, cell.y + cell.height, thresholdY);
    if (best) {
      nh = cell.height + best.delta;
      hitY = best.target;
    }
  }

  // 最小サイズ保証（負値禁止）。snap が逆方向に効くケースのみ保険。
  if (nw < 1) {
    if (movesLeft) nx = cell.x + cell.width - 1;
    nw = 1;
  }
  if (nh < 1) {
    if (movesTop) ny = cell.y + cell.height - 1;
    nh = 1;
  }

  return {
    cell: { x: nx, y: ny, width: nw, height: nh },
    hitX,
    hitY,
  };
}
