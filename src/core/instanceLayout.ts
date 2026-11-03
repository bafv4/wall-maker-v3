/**
 * エリア内のインスタンス 1 枚ごとの矩形（実解像度 px）。プレビューでウォールを描くのに使う。
 *
 * SeedQueue `Layout.Group.grid` と同じ計算（REWRITE_SPEC.md 第6.3章、`Layout.java` で確認）:
 *  - 列幅 = (width - padding × (columns - 1)) / columns、行高も同様（**整数除算**）。
 *  - i 番目（行優先: row × columns + column）は
 *    x + column × 列幅 + padding × column、y + row × 行高 + padding × row。
 *  - padding はインスタンスの「間」だけに入る（外周には入らない）。割り切れない余りは右端・下端に残る。
 *
 * `useGrid=false` は `positions` があればそれを使い、無ければ null（main の行列数は
 * SeedQueue 側の設定値に委ねるので、どう並ぶかはパックからは決まらない）。
 */

import type { Area, AreaCell } from './state';

export function instanceCells(area: Area): AreaCell[] | null {
  if (area.useGrid === false) {
    return area.positions && area.positions.length > 0 ? area.positions : null;
  }
  const { rows, columns, x, y, width, height } = area;
  const padding = area.padding ?? 0;
  if (rows < 1 || columns < 1) return [];
  const columnWidth = Math.trunc((width - padding * (columns - 1)) / columns);
  const rowHeight = Math.trunc((height - padding * (rows - 1)) / rows);
  const cells: AreaCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push({
        x: x + column * columnWidth + padding * column,
        y: y + row * rowHeight + padding * row,
        width: columnWidth,
        height: rowHeight,
      });
    }
  }
  return cells;
}
