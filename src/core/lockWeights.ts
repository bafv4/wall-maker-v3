/**
 * lock 画像の重み（`seedqueue.weight` / `seedqueue.defaultWeight`）。
 *
 * SeedQueue 本体（`customization/LockTexture.java`）の実装をそのまま写したもの。
 * 2026-08-25 に実ソースで確認:
 *
 * ```java
 * // createLockTextures(): lock.png のメタデータからだけ defaultWeight を読む
 * int defaultWeight = 1;
 * MainLockTextureMetadata metadata = resourceManager.getResource(lock)
 *     .getMetadata(MainLockTextureMetadata.READER);   // key = "seedqueue"
 * if (metadata != null) defaultWeight = metadata.defaultWeight;
 *
 * // LockTexture(): 各画像のメタデータを読み、0（＝未指定）なら defaultWeight で埋める
 * if (metadata.weight == 0) metadata.weight = defaultWeight;
 * public int getWeight() { return Math.max(1, this.metadata.weight); }
 * ```
 *
 * 抽選は `random.nextInt(重みの総和)` を各画像の `getWeight()` で累積して引く方式
 * （`SeedQueueWallScreen.getLockTexture`）。したがって選ばれる確率は
 * **その画像の実効重み ÷ 全画像の実効重みの総和**になる。
 *
 * 注意: `defaultWeight` は GSON がフィールド未指定を 0 のままにするため、
 * 「`.mcmeta` を書かない」＝「defaultWeight = 1」と同義。0 を出力しても同じ意味になるので、
 * 既定値のときは `.mcmeta` 自体を出さない（{@link buildLockMcmeta}）。
 */

import { toSafeInt } from './coords';
import type { LockImage, LockImages } from './state';

/** `seedqueue` メタデータのキー名（Java 側 `ResourceMetadataReader.getKey()`）。 */
export const SEEDQUEUE_MCMETA_KEY = 'seedqueue' as const;

/**
 * 重みの上限。仕様上の上限は無いが、抽選は Java の `int` で総和を取るため
 * 「枚数 × 重み」が桁あふれしない範囲に抑える（255 枚 × 10000 でも int に収まる）。
 */
export const MAX_LOCK_WEIGHT = 10000;

/** SeedQueue が `defaultWeight` を読めなかったときの値。 */
export const DEFAULT_LOCK_WEIGHT = 1;

/**
 * コレクションの既定重み。未指定・不正値は {@link DEFAULT_LOCK_WEIGHT} に倒す。
 * `Math.max(1, …)` は SeedQueue 側にもあるが、出力前にここで揃えておく。
 */
export function effectiveDefaultWeight(lockImages: LockImages): number {
  return toSafeInt(
    lockImages.defaultWeight,
    DEFAULT_LOCK_WEIGHT,
    1,
    MAX_LOCK_WEIGHT,
  );
}

/**
 * 画像 1 枚の実効重み。個別 `weight` が無い（＝ Java 側で 0）ときは既定重みを使う。
 */
export function effectiveWeight(image: LockImage, defaultWeight: number): number {
  if (image.weight === undefined) return defaultWeight;
  // 0 は Java 側で「未指定」と同じ扱い（defaultWeight で埋められる）。
  const w = toSafeInt(image.weight, defaultWeight, 0, MAX_LOCK_WEIGHT);
  return w === 0 ? defaultWeight : Math.max(1, w);
}

/**
 * 各画像が抽選される確率（0..1）。UI 表示用。
 * 画像が無い場合は空配列を返す。
 */
export function lockWeightShares(lockImages: LockImages): number[] {
  const def = effectiveDefaultWeight(lockImages);
  const weights = lockImages.images.map((img) => effectiveWeight(img, def));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  return weights.map((w) => w / sum);
}

/**
 * 1 枚分の `.mcmeta` を組み立てる。出力不要なら `null`。
 *
 * - `seedqueue.weight` は既定重みと同じなら省略できる（Java 側で同じ結果になる）。
 * - `seedqueue.defaultWeight` は **`lock.png` のときだけ**意味を持つ（`isFirst`）。
 * - `mcmetaExtra`（`animation` など取り込み時に保持した他セクション）があれば必ず戻す。
 */
export function buildLockMcmeta(
  image: LockImage,
  opts: { isFirst: boolean; defaultWeight: number },
): string | null {
  const seedqueue: Record<string, number> = {};

  const w = effectiveWeight(image, opts.defaultWeight);
  // 既定重みと一致するなら書かなくても同じ抽選結果になる。差分だけ出す。
  if (image.weight !== undefined && w !== opts.defaultWeight) {
    seedqueue.weight = w;
  }
  if (opts.isFirst && opts.defaultWeight !== DEFAULT_LOCK_WEIGHT) {
    seedqueue.defaultWeight = opts.defaultWeight;
  }

  const extra = image.mcmetaExtra ?? {};
  const hasSeedqueue = Object.keys(seedqueue).length > 0;
  const hasExtra = Object.keys(extra).length > 0;
  if (!hasSeedqueue && !hasExtra) return null;

  const out: Record<string, unknown> = { ...extra };
  if (hasSeedqueue) out[SEEDQUEUE_MCMETA_KEY] = seedqueue;
  return JSON.stringify(out, null, 2);
}

/**
 * `.mcmeta` の中身を読み、`seedqueue` セクションと**それ以外**に分ける。
 * 壊れた JSON は「メタデータ無し」として扱う（パック全体を落とさない）。
 */
export function parseLockMcmeta(text: string | undefined): {
  weight?: number;
  defaultWeight?: number;
  extra?: Record<string, unknown>;
} {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn('parseLockMcmeta: .mcmeta の JSON を解釈できませんでした');
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const obj = raw as Record<string, unknown>;
  const { [SEEDQUEUE_MCMETA_KEY]: sq, ...rest } = obj;
  const out: {
    weight?: number;
    defaultWeight?: number;
    extra?: Record<string, unknown>;
  } = {};

  if (Object.keys(rest).length > 0) out.extra = rest;
  if (typeof sq !== 'object' || sq === null || Array.isArray(sq)) return out;

  const s = sq as Record<string, unknown>;
  if (typeof s.weight === 'number' && Number.isFinite(s.weight)) {
    // Java の GSON はフィールド未指定を 0 のままにし、`weight == 0` を defaultWeight で
    // 埋める。つまり 0 は「未指定」と同義なので、state 上も未設定として扱う
    // （0 のまま持つと UI の重み入力に 0 が表示され、実効値と食い違って見える）。
    const w = toSafeInt(s.weight, DEFAULT_LOCK_WEIGHT, 0, MAX_LOCK_WEIGHT);
    if (w > 0) out.weight = w;
  }
  if (typeof s.defaultWeight === 'number' && Number.isFinite(s.defaultWeight)) {
    out.defaultWeight = toSafeInt(
      s.defaultWeight,
      DEFAULT_LOCK_WEIGHT,
      1,
      MAX_LOCK_WEIGHT,
    );
  }
  return out;
}
