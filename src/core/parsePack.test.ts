/**
 * parsePack の信頼境界テスト。
 *
 * `custom_layout.json` は**インポートしたパック（＝外部・攻撃者が中身を決められる）**由来。
 * parsePack はその唯一の入口なので、ここを通った後の WallState は常に
 * アプリの不変条件を満たしていなければならない。
 *
 * ここで固定するのは「壊れた入力が state に入らないこと」だけで、
 * 出力パックのフィクスチャ比較は行わない（CLAUDE.md「Verification」）。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GRID_COUNT } from './coords';
import { parsePack } from './parsePack';
import { PACK_PATHS, type VirtualPack } from './types';

const RESOLUTION = { width: 1920, height: 1080 };

/** custom_layout.json だけを持つ最小パックを組む。 */
function packWithLayout(layout: unknown): VirtualPack {
  return new Map([[PACK_PATHS.customLayout, JSON.stringify(layout)]]);
}

describe('parsePack — rows/columns のクランプ', () => {
  it('巨大な rows/columns を MAX_GRID_COUNT に丸める（描画 DoS の遮断）', async () => {
    // 細工パック: グリッド線 1 本＝1 要素のループを 10 億回まわそうとする値。
    const wall = await parsePack(
      packWithLayout({
        main: {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          rows: 1_000_000_000,
          columns: 1_000_000_000,
        },
        replaceLockedInstances: false,
      }),
      { resolution: RESOLUTION },
    );

    expect(wall.layout.main.rows).toBe(MAX_GRID_COUNT);
    expect(wall.layout.main.columns).toBe(MAX_GRID_COUNT);
  });

  it('locked / preparing のエリアも同じ上限でクランプする', async () => {
    const huge = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rows: 999_999,
      columns: 999_999,
    };
    const wall = await parsePack(
      packWithLayout({
        main: huge,
        locked: huge,
        preparing: [huge, huge],
        replaceLockedInstances: false,
      }),
      { resolution: RESOLUTION },
    );

    const areas = [wall.layout.main, wall.layout.locked, ...wall.layout.preparing];
    expect(areas.length).toBe(4);
    for (const area of areas) {
      expect(area.rows).toBeLessThanOrEqual(MAX_GRID_COUNT);
      expect(area.columns).toBeLessThanOrEqual(MAX_GRID_COUNT);
      expect(area.rows).toBeGreaterThanOrEqual(1);
      expect(area.columns).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    ['0', 0],
    ['負値', -10],
    ['小数', 2.9],
    ['文字列', 'many'],
    ['null', null],
  ])('不正な rows（%s）でも 1 以上の整数になる', async (_label, rows) => {
    const wall = await parsePack(
      packWithLayout({
        main: { x: 0, y: 0, width: 100, height: 100, rows, columns: rows },
        replaceLockedInstances: false,
      }),
      { resolution: RESOLUTION },
    );

    expect(Number.isInteger(wall.layout.main.rows)).toBe(true);
    expect(wall.layout.main.rows).toBeGreaterThanOrEqual(1);
    expect(wall.layout.main.columns).toBeGreaterThanOrEqual(1);
  });

  it('通常のウォール構成はそのまま復元する（クランプが効きすぎていない）', async () => {
    const wall = await parsePack(
      packWithLayout({
        main: {
          x: 10,
          y: 20,
          width: 800,
          height: 600,
          rows: 3,
          columns: 4,
        },
        replaceLockedInstances: true,
      }),
      { resolution: RESOLUTION },
    );

    expect(wall.layout.main).toMatchObject({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      rows: 3,
      columns: 4,
      useGrid: true,
    });
    expect(wall.replaceLockedInstances).toBe(true);
  });
});

describe('parsePack — 座標の整数化', () => {
  it('小数リテラルは framebuffer 割合として絶対 px に変換し、整数で返す', async () => {
    // SeedQueue 仕様: 小数点付き＝割合、整数＝絶対 px（CLAUDE.md 第6.3.1章）。
    const wall = await parsePack(
      packWithLayout({
        main: {
          x: 0.5,
          y: 0.25,
          width: 0.5,
          height: 0.5,
          rows: 2,
          columns: 2,
        },
        replaceLockedInstances: false,
      }),
      { resolution: RESOLUTION },
    );

    expect(wall.layout.main).toMatchObject({
      x: 960,
      y: 270,
      width: 960,
      height: 540,
    });
    for (const v of [
      wall.layout.main.x,
      wall.layout.main.y,
      wall.layout.main.width,
      wall.layout.main.height,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('parsePack — 壊れた入力', () => {
  it('custom_layout.json が無ければ throw する', async () => {
    await expect(
      parsePack(new Map(), { resolution: RESOLUTION }),
    ).rejects.toThrow(/custom_layout\.json/);
  });

  it('custom_layout.json が JSON でなければ throw する', async () => {
    const pack: VirtualPack = new Map([
      [PACK_PATHS.customLayout, '{ not json'],
    ]);
    await expect(parsePack(pack, { resolution: RESOLUTION })).rejects.toThrow(
      /custom_layout\.json/,
    );
  });
});
