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

import {
  applyColorAdjust,
  applyGaussianBlur,
  gaussianBoxRadii,
  hasImageAdjust,
} from './imageAdjust';
import type {
  BinaryRef,
  ColorLayer,
  GradientLayer,
  ImageAdjust,
  ImageLayer,
  Resolution,
  ShapeLayer,
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
export function get2DContext(
  canvas: AnyCanvas,
  settings?: CanvasRenderingContext2DSettings,
): AnyCtx2D | null {
  // OffscreenCanvas はメインスレッド / Worker 双方で利用可能。
  // HTMLCanvasElement は Worker では undefined になるため OffscreenCanvas 側で分岐する。
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.getContext('2d', settings);
  }
  return (canvas as HTMLCanvasElement).getContext('2d', settings);
}

/** 作業用の canvas。Worker でも使えるよう OffscreenCanvas を優先する。 */
function createScratchCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 画像レイヤの描画元（画像内の px）と描画先（実解像度 px）の矩形。 */
function imageGeometry(
  layer: ImageLayer,
  bitmap: ImageBitmap,
  res: Resolution,
): { src: Rect; dst: Rect } {
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

  return {
    src: { x: sx, y: sy, width: sw, height: sh },
    dst: { x: dx, y: dy, width: dw, height: dh },
  };
}

function drawImageLayerSync(
  ctx: AnyCtx2D,
  layer: ImageLayer,
  bitmap: ImageBitmap,
  res: Resolution,
): void {
  const { src, dst } = imageGeometry(layer, bitmap, res);
  ctx.drawImage(
    bitmap,
    src.x,
    src.y,
    src.width,
    src.height,
    dst.x,
    dst.y,
    dst.width,
    dst.height,
  );
}

/**
 * 補正済み画像のキャッシュ（画像 1 枚につき直近の 1 件）。補正は全画素の処理で重いので、
 * 他のレイヤやエリアの操作でプレビューを描き直すたびには繰り返さない。
 */
const adjustedCache = new WeakMap<
  ImageBitmap,
  { key: string; canvas: AnyCanvas }
>();

/**
 * 色調補正・ぼかし付きで画像レイヤを描く。補正は描画先の画素（canvas のバッキングストア）で
 * 行い、ぼかしの半径も同じ倍率で縮めるので、縮小プレビューでも書き出しと同じ見た目になる。
 * 処理するのは描画範囲のうち canvas とぼかしの裾野が届く部分だけ（cover のはみ出しは処理しない）。
 * 呼び出し側の transform（実解像度 → バッキングストアの縮小）は使わず、ここで座標を換算する。
 */
function drawAdjustedImageLayer(
  ctx: AnyCtx2D,
  layer: ImageLayer,
  adjust: ImageAdjust,
  bitmap: ImageBitmap,
  res: Resolution,
  scaleX: number,
  scaleY: number,
): void {
  const { src, dst } = imageGeometry(layer, bitmap, res);
  const radiiX = gaussianBoxRadii(adjust.blur * scaleX);
  const radiiY = gaussianBoxRadii(adjust.blur * scaleY);
  const marginX = radiiX.reduce((sum, r) => sum + r, 0);
  const marginY = radiiY.reduce((sum, r) => sum + r, 0);
  // 描画先は画素境界に丸める（ずれは 0.5px 未満）。縮小プレビューで端が画素の途中に来ると
  // 端の行が半透明になり、それを「端の延長」に使ったぼかしで内側まで透けて暗くなるため。
  const rx0 = Math.round(dst.x * scaleX);
  const ry0 = Math.round(dst.y * scaleY);
  const rx1 = Math.max(rx0 + 1, Math.round((dst.x + dst.width) * scaleX));
  const ry1 = Math.max(ry0 + 1, Math.round((dst.y + dst.height) * scaleY));
  const x0 = Math.max(rx0, -marginX);
  const y0 = Math.max(ry0, -marginY);
  const x1 = Math.min(rx1, ctx.canvas.width + marginX);
  const y1 = Math.min(ry1, ctx.canvas.height + marginY);
  if (x1 <= x0 || y1 <= y0) return;

  const key = [
    src.x,
    src.y,
    src.width,
    src.height,
    rx0,
    ry0,
    rx1,
    ry1,
    x0,
    y0,
    x1,
    y1,
    ctx.imageSmoothingQuality,
    adjust.lightness,
    adjust.saturation,
    adjust.hue,
    radiiX.join('/'),
    radiiY.join('/'),
  ].join(',');
  let cached = adjustedCache.get(bitmap);
  if (cached?.key !== key) {
    const canvas = createScratchCanvas(x1 - x0, y1 - y0);
    const sctx = get2DContext(canvas, { willReadFrequently: true });
    if (!sctx) return;
    sctx.imageSmoothingQuality = ctx.imageSmoothingQuality;
    sctx.drawImage(
      bitmap,
      src.x,
      src.y,
      src.width,
      src.height,
      rx0 - x0,
      ry0 - y0,
      rx1 - rx0,
      ry1 - ry0,
    );
    const image = sctx.getImageData(0, 0, x1 - x0, y1 - y0);
    applyColorAdjust(image.data, adjust);
    applyGaussianBlur(image.data, image.width, image.height, radiiX, radiiY);
    sctx.putImageData(image, 0, 0);
    cached = { key, canvas };
    adjustedCache.set(bitmap, cached);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(cached.canvas, x0, y0);
  ctx.restore();
}

/**
 * 非同期版（外部互換）。キャッシュを利用するため 2 回目以降の呼び出しは microtask-fast。
 * 色調補正・ぼかし（layer.adjust）は描かない（補正込みの描画は renderBackgroundToCanvas）。
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

type Point = readonly [number, number];

/** 角を持つ図形の頂点（時計回り）。ellipse は角が無いので null。 */
function shapeVertices(layer: ShapeLayer): Point[] | null {
  const { x, y, width, height } = layer.transform;
  switch (layer.shape) {
    case 'rect':
      return [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ];
    case 'triangle':
      return [
        [x + width / 2, y],
        [x + width, y + height],
        [x, y + height],
      ];
    case 'ellipse':
      return null;
  }
}

/**
 * 凸多角形の角丸の幾何。
 *  - `cots[i]`: 頂点 i の内角の半分の cot。半径 r で丸めると、頂点から接点までの長さは r × cots[i]。
 *  - `maxRadius`: 隣り合う頂点の接点が辺の上で重ならない最大半径
 *    （rect は短辺の半分、triangle は内接円の半径になる）。
 */
function roundedPolygonGeometry(pts: readonly Point[]): {
  cots: number[];
  maxRadius: number;
} {
  const n = pts.length;
  const cots = pts.map((cur, i) => {
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const ax = prev[0] - cur[0];
    const ay = prev[1] - cur[1];
    const bx = next[0] - cur[0];
    const by = next[1] - cur[1];
    const angle = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    return 1 / Math.tan(angle / 2);
  });
  let maxRadius = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    maxRadius = Math.min(maxRadius, len / (cots[i] + cots[(i + 1) % n]));
  }
  return { cots, maxRadius: Number.isFinite(maxRadius) ? maxRadius : 0 };
}

/** 角丸半径の上限（px・整数）。ellipse は 0。エディタのスライダ上限に使う。 */
export function maxCornerRadius(layer: ShapeLayer): number {
  const pts = shapeVertices(layer);
  if (!pts) return 0;
  // cot(45°) が浮動小数の誤差で 1 をわずかに超え、短辺 270 の上限が 134.99… → 134 になるのを防ぐ
  return Math.floor(roundedPolygonGeometry(pts).maxRadius + 1e-6);
}

/**
 * 凸多角形を塗る。radius > 0 なら各頂点を arcTo で丸める。
 * arcTo は半径が大きすぎても抑えてくれず辺がはみ出すので、`maxRadius` に丸めてから描く。
 */
function fillPolygon(ctx: AnyCtx2D, pts: readonly Point[], radius: number): void {
  const n = pts.length;
  const geo = radius > 0 ? roundedPolygonGeometry(pts) : null;
  const r = geo ? Math.min(radius, geo.maxRadius) : 0;
  ctx.beginPath();
  if (geo && r > 0) {
    // 頂点 0 の手前の接点から始める。辺の中点から始めると、細長い三角形では
    // 接点が中点より向こうに来て線が折り返す。
    const [px, py] = pts[n - 1];
    const [cx, cy] = pts[0];
    const t = (r * geo.cots[0]) / Math.hypot(px - cx, py - cy);
    ctx.moveTo(cx + (px - cx) * t, cy + (py - cy) * t);
    for (let i = 0; i < n; i++) {
      const [vx, vy] = pts[i];
      const [nx, ny] = pts[(i + 1) % n];
      ctx.arcTo(vx, vy, nx, ny, r);
    }
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.closePath();
  ctx.fill();
}

/** 図形は transform（外接矩形）の中に描く。解像度は使わない（座標は実解像度 px のまま）。 */
export function drawShapeLayer(ctx: AnyCtx2D, layer: ShapeLayer): void {
  const { x, y, width, height } = layer.transform;
  const radius = layer.cornerRadius ?? 0;
  ctx.fillStyle = layer.color;
  switch (layer.shape) {
    case 'rect':
    case 'triangle': {
      const pts = shapeVertices(layer);
      if (!pts) return;
      // 角丸なしの四角形は従来どおり fillRect（既存パックの出力を変えない）
      if (layer.shape === 'rect' && radius <= 0) {
        ctx.fillRect(x, y, width, height);
      } else {
        fillPolygon(ctx, pts, radius);
      }
      return;
    }
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(
        x + width / 2,
        y + height / 2,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      return;
  }
}

// ---------------------------------------------------------------------------
// メイン関数: pre-decode → clear → 同期で全レイヤ draw
// ---------------------------------------------------------------------------

/**
 * background.layers を canvas に描画する。
 *
 * レイヤ座標は常に **resolution 座標系**（実解像度 px）で解釈する。
 * canvas のバッキングストアが resolution と異なるサイズでも良く、その場合は
 * `canvas.width / resolution.width`（Y も同様）の scale を掛けて写す。
 *   - `buildPack`: canvas を resolution そのままで確保するため scale = 1（無変換）。
 *   - `WallPreview`: 表示サイズ × devicePixelRatio で確保するため scale < 1。
 *     実解像度でバッキングストアを持つと入力イベントごとに 8MB 級の再確保と
 *     フル解像度の再合成が走るため、表示に必要な画素数だけを持たせる。
 *
 * 重要な順序:
 *   1) 必要な ImageBitmap を**並列で先行 decode**（cache hit なら即座に resolve）。
 *   2) clearRect で全消し → 同じ tick の中で全レイヤを同期描画 → drawImage。
 *      これにより「消去後 / 描画前」の一瞬の透過状態が発生しない。
 *
 * `isCancelled` が decode 完了時点で true を返す場合は何も描かずに終了する
 * （後発の描画結果を先発の古い描画で上書きしないための順序保証）。
 */
export async function renderBackgroundToCanvas(
  canvas: AnyCanvas,
  background: BackgroundField,
  resolution: Resolution,
  isCancelled?: () => boolean,
): Promise<void> {
  const ctx = get2DContext(canvas);
  if (!ctx) throw new Error('renderBackgroundToCanvas: 2D context unavailable');

  // 1) 必要な bitmap を並列で先行 decode（キャッシュヒットでは microtask 解決）
  //    source が未解決の ref（永続化復元の一時失敗でバイト未ロード）のレイヤは
  //    描画をスキップする。1 レイヤの未解決で背景全体の描画を落とさない。
  const bitmaps = await Promise.all(
    background.layers.map((l) =>
      l.type === 'image' && l.visible && l.source.kind === 'inline'
        ? getCachedBitmap(l.source)
        : null,
    ),
  );

  if (isCancelled?.()) return;

  // 2) ここから同期処理。clear → draw を 1 tick 内で完結させる。
  const scaleX = resolution.width > 0 ? canvas.width / resolution.width : 1;
  const scaleY = resolution.height > 0 ? canvas.height / resolution.height : 1;

  ctx.save();
  // clear は無変換（＝バッキングストア px）で行う。scale 適用後に
  // clearRect(0,0,canvas.width,canvas.height) すると縮小時に消し残る。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (scaleX < 1 || scaleY < 1) {
    // 縮小プレビューでの drawImage のジャギーを抑える（等倍・拡大時は既定のまま）
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

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
        if (!bitmap) break;
        if (hasImageAdjust(layer.adjust)) {
          drawAdjustedImageLayer(
            ctx,
            layer,
            layer.adjust,
            bitmap,
            resolution,
            scaleX,
            scaleY,
          );
        } else {
          drawImageLayerSync(ctx, layer, bitmap, resolution);
        }
        break;
      }
      case 'gradient':
        drawGradientLayer(ctx, layer, resolution);
        break;
      case 'shape':
        drawShapeLayer(ctx, layer);
        break;
    }
    ctx.restore();
  }

  // scale / imageSmoothingQuality を戻す（上の save と対）
  ctx.restore();
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
