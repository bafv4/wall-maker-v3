/**
 * imageAdjust — 画像レイヤの色調補正（明度・彩度・色相）とぼかしの画素処理。
 * renderBackground から呼ぶ（プレビューと書き出しで同じ処理を通す）。
 *
 * Canvas の `ctx.filter`（CSS フィルタ）は使わない。Safari は 18 時点でもフラグ付きでしか
 * 対応しておらず、macOS 版（WKWebView）では黙って効かない（＝「Mac だけ補正が消えた
 * background.png」になる）。どの環境でも同じ結果にするため ImageData を直接処理する。
 *
 *  - 色相・彩度は Filter Effects 仕様の feColorMatrix（hueRotate / saturate）と同じ行列。
 *  - 明度は負で黒、正で白へ線形に寄せる（画像編集ソフトの「色相・彩度」の明度と同じ考え方）。
 *  - ぼかしは 3 回のボックスぼかしでガウスぼかしを近似する（計算量は半径によらず画素数に比例）。
 *    範囲外は端の画素を延長して扱い、透明画素の色が滲まないよう乗算済みアルファで処理する。
 */

import type { ImageAdjust } from './state';

/** 補正が 1 つでも入っているか（全 0・省略なら素の drawImage で描ける）。 */
export function hasImageAdjust(
  adjust: ImageAdjust | undefined,
): adjust is ImageAdjust {
  return (
    adjust !== undefined &&
    (adjust.lightness !== 0 ||
      adjust.saturation !== 0 ||
      adjust.hue !== 0 ||
      adjust.blur !== 0)
  );
}

// ---------------------------------------------------------------------------
// 色調補正
// ---------------------------------------------------------------------------

/** 色相回転 → 彩度の順に掛ける 3x3 行列（行優先）。 */
function colorMatrix(hueDeg: number, saturation: number): number[] {
  const rad = (hueDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hue = [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
  const k = 1 + saturation / 100;
  const sat = [
    0.213 + 0.787 * k,
    0.715 - 0.715 * k,
    0.072 - 0.072 * k,
    0.213 - 0.213 * k,
    0.715 + 0.285 * k,
    0.072 - 0.072 * k,
    0.213 - 0.213 * k,
    0.715 - 0.715 * k,
    0.072 + 0.928 * k,
  ];
  const m: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let v = 0;
      for (let i = 0; i < 3; i++) v += sat[row * 3 + i] * hue[i * 3 + col];
      m.push(v);
    }
  }
  return m;
}

/** RGBA（乗算前アルファ）の明度・彩度・色相をその場で補正する。アルファは変えない。 */
export function applyColorAdjust(
  data: Uint8ClampedArray,
  adjust: ImageAdjust,
): void {
  const useMatrix = adjust.hue !== 0 || adjust.saturation !== 0;
  const l = adjust.lightness / 100;
  if (!useMatrix && l === 0) return;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = colorMatrix(
    adjust.hue,
    adjust.saturation,
  );
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (useMatrix) {
      const nr = m0 * r + m1 * g + m2 * b;
      const ng = m3 * r + m4 * g + m5 * b;
      const nb = m6 * r + m7 * g + m8 * b;
      // 明度を寄せる前に 0..255 へ戻す（範囲外のまま寄せると白・黒に届かない）
      r = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      g = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      b = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    }
    if (l > 0) {
      r += (255 - r) * l;
      g += (255 - g) * l;
      b += (255 - b) * l;
    } else if (l < 0) {
      r *= 1 + l;
      g *= 1 + l;
      b *= 1 + l;
    }
    // Uint8ClampedArray への代入で丸めとクランプが入る
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

// ---------------------------------------------------------------------------
// ぼかし
// ---------------------------------------------------------------------------

const BLUR_PASSES = 3;

/**
 * 標準偏差 `sigma` px のガウスぼかしを近似するボックスぼかしの半径（各パス）。
 * 半径 0 のパスは除く（sigma が 1px 未満程度なら空配列＝ぼかさない）。
 * 合計がぼかしの裾野の幅になるので、呼び出し側は処理範囲の余白にも使う。
 */
export function gaussianBoxRadii(sigma: number): number[] {
  if (!(sigma > 0)) return [];
  // 幅 w のボックスの分散は (w² - 1) / 12。幅 wl と wl + 2 のボックスを組み合わせて
  // 分散の合計を sigma² に合わせる。
  const n = BLUR_PASSES;
  let wl = Math.floor(Math.sqrt((12 * sigma * sigma) / n + 1));
  if (wl % 2 === 0) wl--;
  const m = Math.round(
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4),
  );
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wl + 2) - 1) / 2;
    if (r > 0) radii.push(r);
  }
  return radii;
}

/** 横方向のボックスぼかし（範囲外は端の画素を延長）。 */
function boxBlurH(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
): void {
  const inv = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let k = -r; k <= r; k++) {
      const j = row + (k < 0 ? 0 : k >= w ? w - 1 : k) * 4;
      s0 += src[j];
      s1 += src[j + 1];
      s2 += src[j + 2];
      s3 += src[j + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      dst[o] = s0 * inv;
      dst[o + 1] = s1 * inv;
      dst[o + 2] = s2 * inv;
      dst[o + 3] = s3 * inv;
      const add = row + (x + r + 1 < w ? x + r + 1 : w - 1) * 4;
      const sub = row + (x - r > 0 ? x - r : 0) * 4;
      s0 += src[add] - src[sub];
      s1 += src[add + 1] - src[sub + 1];
      s2 += src[add + 2] - src[sub + 2];
      s3 += src[add + 3] - src[sub + 3];
    }
  }
}

/** 縦方向のボックスぼかし。行単位で全列の和を持ち、メモリを先頭から順に読む。 */
function boxBlurV(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
): void {
  const inv = 1 / (r + r + 1);
  const stride = w * 4;
  const acc = new Float64Array(stride);
  for (let k = -r; k <= r; k++) {
    const row = (k < 0 ? 0 : k >= h ? h - 1 : k) * stride;
    for (let i = 0; i < stride; i++) acc[i] += src[row + i];
  }
  for (let y = 0; y < h; y++) {
    const out = y * stride;
    const add = (y + r + 1 < h ? y + r + 1 : h - 1) * stride;
    const sub = (y - r > 0 ? y - r : 0) * stride;
    for (let i = 0; i < stride; i++) {
      dst[out + i] = acc[i] * inv;
      acc[i] += src[add + i] - src[sub + i];
    }
  }
}

/**
 * RGBA（乗算前アルファ）をその場でぼかす。半径は `gaussianBoxRadii` の戻り値を軸ごとに渡す
 * （プレビューの縦横で縮小率が違っても、書き出しと同じ見た目に縮めるため）。
 */
export function applyGaussianBlur(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radiiX: readonly number[],
  radiiY: readonly number[],
): void {
  if (radiiX.length === 0 && radiiY.length === 0) return;
  const n = width * height * 4;
  let a = new Float32Array(n);
  let b = new Float32Array(n);
  // 乗算済みアルファへ（透明画素の RGB が混ざって縁が黒ずむのを防ぐ）
  for (let i = 0; i < n; i += 4) {
    const alpha = data[i + 3] / 255;
    a[i] = data[i] * alpha;
    a[i + 1] = data[i + 1] * alpha;
    a[i + 2] = data[i + 2] * alpha;
    a[i + 3] = data[i + 3];
  }
  for (const r of radiiX) {
    boxBlurH(a, b, width, height, r);
    [a, b] = [b, a];
  }
  for (const r of radiiY) {
    boxBlurV(a, b, width, height, r);
    [a, b] = [b, a];
  }
  for (let i = 0; i < n; i += 4) {
    const alpha = a[i + 3];
    if (alpha <= 0) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
      continue;
    }
    const k = 255 / alpha;
    data[i] = a[i] * k;
    data[i + 1] = a[i + 1] * k;
    data[i + 2] = a[i + 2] * k;
    data[i + 3] = alpha;
  }
}
