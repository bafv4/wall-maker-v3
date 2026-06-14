/**
 * 背景レイヤを Canvas に描画する純関数群（buildPack と WallPreview の共有実装）。
 * 仕様: REWRITE_SPEC.md 第4.2章。
 *
 *  - 入力は in-memory state（BinaryRef は `inline` のみ）。
 *  - 出力は Canvas に描画する副作用。バイト化は呼び出し側。
 *  - 同一コードを buildPack と WallPreview で共有し見た目を一致させる。
 *
 * 画像ビットマップは `bitmapCache`（WeakMap キー = source.bytes）にキャッシュする。
 * 同じ画像レイヤの transform/opacity だけが変わるケース（プレビューでのドラッグ）で
 * `createImageBitmap` を呼び直さず、`clearRect → drawImage` を**一連の同期処理**として行えるため
 * 描画途中の一瞬の透過（ちらつき）が発生しない。
 */

import type {
  BinaryRef,
  ColorLayer,
  GradientLayer,
  ImageLayer,
  Resolution,
  WallState,
} from './state';

type BackgroundField = WallState['background'];

/**
 * Canvas / 2D コンテキスト両対応の型エイリアス。
 * Web Worker（`OffscreenCanvas`）と main thread（`HTMLCanvasElement` ＋ 互換のため `OffscreenCanvas`）
 * の双方から同じ描画コードを呼べるようにする。両方とも `fillStyle` / `fillRect` /
 * `drawImage` / `createLinearGradient` 等を共通インターフェースとして提供する。
 */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyCtx2D =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/**
 * `AnyCanvas` から 2D コンテキストを取り出す唯一の窓口。
 * 環境分岐（`OffscreenCanvas` か否か）はここに閉じ、呼び出し側は型を意識しない。
 */
export function get2DContext(canvas: AnyCanvas): AnyCtx2D | null {
  // OffscreenCanvas はメインスレッド / Worker 双方で利用可能。
  // HTMLCanvasElement は Worker では undefined になるため OffscreenCanvas 側で分岐する。
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.getContext('2d');
  }
  return (canvas as HTMLCanvasElement).getContext('2d');
}

// ---------------------------------------------------------------------------
// ImageBitmap キャッシュ
// ---------------------------------------------------------------------------

const bitmapCache = new WeakMap<Uint8Array, Promise<ImageBitmap>>();

function getCachedBitmap(source: BinaryRef): Promise<ImageBitmap> {
  if (source.kind !== 'inline') {
    return Promise.reject(
      new Error('drawImageLayer: source must be inline (got ref)'),
    );
  }
  const cached = bitmapCache.get(source.bytes);
  if (cached) return cached;
  // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
  const blob = new Blob([source.bytes as Uint8Array<ArrayBuffer>], {
    type: source.mimeType ?? 'image/png',
  });
  const promise = createImageBitmap(blob);
  bitmapCache.set(source.bytes, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// 個別レイヤの同期描画
// ---------------------------------------------------------------------------

export function drawColorLayer(
  ctx: AnyCtx2D,
  layer: ColorLayer,
  res: Resolution,
): void {
  ctx.fillStyle = layer.color;
  ctx.fillRect(0, 0, res.width, res.height);
}

function drawImageLayerSync(
  ctx: AnyCtx2D,
  layer: ImageLayer,
  bitmap: ImageBitmap,
  res: Resolution,
): void {
  const sx = layer.crop?.x ?? 0;
  const sy = layer.crop?.y ?? 0;
  const sw = layer.crop?.width ?? bitmap.width;
  const sh = layer.crop?.height ?? bitmap.height;

  let dx = 0;
  let dy = 0;
  let dw = res.width;
  let dh = res.height;

  if (layer.fit === 'cover') {
    const s = Math.max(res.width / sw, res.height / sh);
    dw = sw * s;
    dh = sh * s;
    dx = (res.width - dw) / 2;
    dy = (res.height - dh) / 2;
  } else if (layer.fit === 'contain') {
    const s = Math.min(res.width / sw, res.height / sh);
    dw = sw * s;
    dh = sh * s;
    dx = (res.width - dw) / 2;
    dy = (res.height - dh) / 2;
  } else if (layer.fit === 'manual' && layer.transform) {
    dx = layer.transform.x;
    dy = layer.transform.y;
    dw = layer.transform.width;
    dh = layer.transform.height;
  }
  // fit === 'stretch' は dw/dh = 解像度のまま
  // fit === 'manual' で transform 未設定なら stretch と同じ振る舞い

  ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
}

/**
 * 非同期版（外部互換）。キャッシュを利用するため 2 回目以降の呼び出しは microtask-fast。
 */
export async function drawImageLayer(
  ctx: AnyCtx2D,
  layer: ImageLayer,
  res: Resolution,
): Promise<void> {
  const bitmap = await getCachedBitmap(layer.source);
  drawImageLayerSync(ctx, layer, bitmap, res);
}

export function drawGradientLayer(
  ctx: AnyCtx2D,
  layer: GradientLayer,
  res: Resolution,
): void {
  const angleRad = (layer.angle * Math.PI) / 180;
  const cx = res.width / 2;
  const cy = res.height / 2;
  const dx = Math.sin(angleRad);
  const dy = -Math.cos(angleRad);
  const half = Math.hypot(res.width, res.height) / 2;
  const x0 = cx - dx * half;
  const y0 = cy - dy * half;
  const x1 = cx + dx * half;
  const y1 = cy + dy * half;

  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const stop of layer.stops) {
    gradient.addColorStop(clamp01(stop.offset), stop.color);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, res.width, res.height);
}

// ---------------------------------------------------------------------------
// メイン関数: pre-decode → clear → 同期で全レイヤ draw
// ---------------------------------------------------------------------------

/**
 * background.layers を canvas に描画する。canvas のサイズは resolution と一致している前提。
 *
 * 重要な順序:
 *   1) 必要な ImageBitmap を**並列で先行 decode**（cache hit なら即座に resolve）。
 *   2) clearRect で全消し → 同じ tick の中で全レイヤを同期描画 → drawImage。
 *      これにより「消去後 / 描画前」の一瞬の透過状態が発生しない。
 */
export async function renderBackgroundToCanvas(
  canvas: AnyCanvas,
  background: BackgroundField,
  resolution: Resolution,
): Promise<void> {
  const ctx = get2DContext(canvas);
  if (!ctx) throw new Error('renderBackgroundToCanvas: 2D context unavailable');

  // 1) 必要な bitmap を並列で先行 decode（キャッシュヒットでは microtask 解決）
  const bitmaps = await Promise.all(
    background.layers.map((l) =>
      l.type === 'image' && l.visible ? getCachedBitmap(l.source) : null,
    ),
  );

  // 2) ここから同期処理。clear → draw を 1 tick 内で完結させる。
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  for (let i = 0; i < background.layers.length; i++) {
    const layer = background.layers[i];
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = clamp01(layer.opacity);
    switch (layer.type) {
      case 'color':
        drawColorLayer(ctx, layer, resolution);
        break;
      case 'image': {
        const bitmap = bitmaps[i];
        if (bitmap) drawImageLayerSync(ctx, layer, bitmap, resolution);
        break;
      }
      case 'gradient':
        drawGradientLayer(ctx, layer, resolution);
        break;
    }
    ctx.restore();
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
