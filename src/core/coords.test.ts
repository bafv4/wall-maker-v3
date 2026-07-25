/**
 * coords の整数化・クランプの不変条件テスト。
 *
 * `clampGridCount` は rows/columns の**上限**を持つ唯一の場所。上限が無いと、外部パックの
 * `custom_layout.json` にある `rows: 1e9` がそのまま state に入り、プレビューが
 * グリッド線 1 本＝1 要素を作り続けてメインスレッドを止める（描画 DoS）。
 * 下限 1（CLAUDE.md の不変条件「rows/columns は 1 以上の整数」）も同時に固定する。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GRID_COUNT, clampGridCount, floorArea, floorInt } from './coords';

describe('clampGridCount', () => {
  it('巨大値を MAX_GRID_COUNT に丸める（描画 DoS の遮断）', () => {
    expect(clampGridCount(1_000_000_000)).toBe(MAX_GRID_COUNT);
    expect(clampGridCount(Number.MAX_SAFE_INTEGER)).toBe(MAX_GRID_COUNT);
    expect(clampGridCount(Infinity)).toBe(1); // 非有限は 1 に倒す
  });

  it('0・負値・NaN は 1 に倒す', () => {
    expect(clampGridCount(0)).toBe(1);
    expect(clampGridCount(-5)).toBe(1);
    expect(clampGridCount(Number.NaN)).toBe(1);
    expect(clampGridCount(-Infinity)).toBe(1);
  });

  it('小数は floor する（state に小数を入れない）', () => {
    expect(clampGridCount(2.7)).toBe(2);
    expect(clampGridCount(1.9)).toBe(1);
  });

  it('通常のウォール構成はそのまま通す', () => {
    for (const n of [1, 2, 3, 4, 6, 9, 20, MAX_GRID_COUNT]) {
      expect(clampGridCount(n)).toBe(n);
    }
  });

  it('出力は常に 1..MAX_GRID_COUNT の整数', () => {
    const inputs = [-1e9, -1, 0, 0.5, 1, 255.9, 256, 257, 1e9, Number.NaN];
    for (const n of inputs) {
      const out = clampGridCount(n);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(1);
      expect(out).toBeLessThanOrEqual(MAX_GRID_COUNT);
    }
  });
});

describe('floorInt / floorArea', () => {
  it('座標を floor 整数化する（小数は SeedQueue が割合と誤解釈するため）', () => {
    expect(floorInt(10.9)).toBe(10);
    expect(floorInt(-0.1)).toBe(-1);

    const area = floorArea({
      x: 10.9,
      y: 20.1,
      width: 100.7,
      height: 50.5,
      rows: 2,
      columns: 3,
      useGrid: true,
      padding: 4.8,
      show: true,
    });
    expect(area).toMatchObject({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      padding: 4,
    });
    for (const v of [area.x, area.y, area.width, area.height, area.padding]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('positions も整数化する', () => {
    const area = floorArea({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rows: 1,
      columns: 1,
      useGrid: false,
      show: true,
      positions: [{ x: 1.9, y: 2.9, width: 3.9, height: 4.9 }],
    });
    expect(area.positions).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });
});
