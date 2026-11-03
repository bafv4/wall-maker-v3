/**
 * editorMeta — 背景レイヤの編集データをパックに同梱する／パックから復元する。
 *
 * SeedQueue が読むのは合成済みの `background.png` だけで、色・グラデーション・図形・元画像の
 * 構成は焼き込まれて失われる。`packInfo.embedEditorData` が true のとき、レイヤ構成を
 * パックルートの `wall-maker/` 配下に残し、Zip / フォルダの再読込でレイヤ単位に復元できるようにする。
 *
 *  - `wall-maker/background.json` … レイヤ構成（座標は書き出し時の解像度の絶対 px）
 *  - `wall-maker/images/<n>.<ext>` … image レイヤの元画像（再エンコードしない元バイト）
 *
 * Minecraft はパックルートの `assets/` 以外を読まないため、ゲーム側の挙動には影響しない。
 *
 * 復元は `background.png` より優先する。メタが壊れている／バージョン不明のときは null を返し、
 * 呼び出し側は従来どおり `background.png` を 1 枚の image レイヤとして復元する。
 */

import { resolveInline } from './binaryFields';
import { floorLayerNumbers, scaleBackgroundLayer } from './coords';
import { isRecord, readBytes, readString } from './packRead';
import {
  IMAGE_ADJUST_KEYS,
  SHAPE_KINDS,
  type AreaCell,
  type BackgroundLayer,
  type GradientStop,
  type ImageAdjust,
  type ImageLayer,
  type Resolution,
  type ShapeKind,
  type ShapeLayer,
  type WallState,
} from './state';
import type { VirtualPack } from './types';

export const EDITOR_META_DIR = 'wall-maker' as const;
export const EDITOR_META_PATH = `${EDITOR_META_DIR}/background.json` as const;
const EDITOR_META_IMAGE_DIR = `${EDITOR_META_DIR}/images`;
const EDITOR_META_VERSION = 1;

// ===========================================================================
// ファイル形式
// ===========================================================================

type MetaLayer =
  | { type: 'color'; color: string; opacity: number; visible: boolean }
  | {
      type: 'gradient';
      stops: GradientStop[];
      angle: number;
      opacity: number;
      visible: boolean;
    }
  | {
      type: 'shape';
      shape: ShapeKind;
      color: string;
      transform: AreaCell;
      /** 省略時は角丸なし（角丸導入前に書き出したメタも同じ形で読める）。 */
      cornerRadius?: number;
      opacity: number;
      visible: boolean;
    }
  | {
      type: 'image';
      /** パック内パス（`wall-maker/images/<n>.<ext>`）。 */
      file: string;
      mimeType?: string;
      fit: ImageLayer['fit'];
      transform?: AreaCell;
      crop?: AreaCell;
      originalFileName?: string;
      /** 省略時は無補正（色調補正の導入前に書き出したメタも同じ形で読める）。 */
      adjust?: ImageAdjust;
      opacity: number;
      visible: boolean;
    };

interface EditorMetaFile {
  version: number;
  /** レイヤ座標の基準解像度。読込時の解像度が異なればスケールする。 */
  resolution: Resolution;
  layers: MetaLayer[];
}

// ===========================================================================
// 書き出し
// ===========================================================================

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/**
 * 背景レイヤ構成と元画像を pack に追加する。非表示レイヤも含める（編集状態の復元が目的のため）。
 * image レイヤの source は inline であること（未解決 ref の検出は binaryFields が担う）。
 */
export function addEditorMeta(pack: VirtualPack, state: WallState): void {
  // 同じバイト列を複数レイヤで使い回している場合は 1 ファイルにまとめる
  const fileByBytes = new Map<Uint8Array, string>();
  const layers = state.background.layers.map((l): MetaLayer => {
    switch (l.type) {
      case 'color':
        return {
          type: 'color',
          color: l.color,
          opacity: l.opacity,
          visible: l.visible,
        };
      case 'gradient':
        return {
          type: 'gradient',
          stops: l.stops,
          angle: l.angle,
          opacity: l.opacity,
          visible: l.visible,
        };
      case 'shape':
        return {
          type: 'shape',
          shape: l.shape,
          color: l.color,
          transform: l.transform,
          cornerRadius: l.cornerRadius,
          opacity: l.opacity,
          visible: l.visible,
        };
      case 'image': {
        const bytes = resolveInline(l.source);
        let file = fileByBytes.get(bytes);
        if (!file) {
          const ext = EXT_BY_MIME[l.source.mimeType ?? 'image/png'] ?? 'bin';
          file = `${EDITOR_META_IMAGE_DIR}/${fileByBytes.size}.${ext}`;
          fileByBytes.set(bytes, file);
          pack.set(file, bytes);
        }
        return {
          type: 'image',
          file,
          mimeType: l.source.mimeType,
          fit: l.fit,
          transform: l.transform,
          crop: l.crop,
          originalFileName: l.originalFileName,
          adjust: l.adjust,
          opacity: l.opacity,
          visible: l.visible,
        };
      }
    }
  });

  const meta: EditorMetaFile = {
    version: EDITOR_META_VERSION,
    resolution: state.resolution,
    layers,
  };
  pack.set(EDITOR_META_PATH, JSON.stringify(meta, null, 2));
}

// ===========================================================================
// 読込
// ===========================================================================

/** メタに記録された基準解像度。メタが無い／読めなければ null。 */
export function readEditorMetaResolution(pack: VirtualPack): Resolution | null {
  return readMetaFile(pack)?.resolution ?? null;
}

/**
 * メタから背景レイヤを復元する。メタが無い／壊れている場合は null。
 * 個々のレイヤが不正（元画像の欠落を含む）な場合はそのレイヤだけ落とす。
 * 座標は `resolution` に合わせてスケールし整数化する。id は新規発行。
 */
export function parseEditorMeta(
  pack: VirtualPack,
  resolution: Resolution,
): BackgroundLayer[] | null {
  const meta = readMetaFile(pack);
  if (!meta) return null;
  const sx = resolution.width / meta.resolution.width;
  const sy = resolution.height / meta.resolution.height;
  const layers: BackgroundLayer[] = [];
  for (const raw of meta.layers) {
    const layer = parseMetaLayer(raw, pack);
    if (!layer) {
      console.warn('parseEditorMeta: invalid layer skipped', raw);
      continue;
    }
    layers.push(scaleBackgroundLayer(layer, sx, sy));
  }
  return layers;
}

function readMetaFile(pack: VirtualPack): EditorMetaFile | null {
  const text = readString(pack, EDITOR_META_PATH);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.version !== EDITOR_META_VERSION) {
      console.warn('parseEditorMeta: unsupported meta version', parsed);
      return null;
    }
    const res = parsed.resolution;
    if (
      !isRecord(res) ||
      !isPositiveNumber(res.width) ||
      !isPositiveNumber(res.height) ||
      !Array.isArray(parsed.layers)
    ) {
      return null;
    }
    return {
      version: EDITOR_META_VERSION,
      resolution: { width: res.width, height: res.height },
      layers: parsed.layers as MetaLayer[],
    };
  } catch (e) {
    console.warn('parseEditorMeta: failed to parse meta', e);
    return null;
  }
}

/** 実行時バリデーション。ファイルは外部入力なので型注釈を信用しない。 */
function parseMetaLayer(raw: unknown, pack: VirtualPack): BackgroundLayer | null {
  if (!isRecord(raw)) return null;
  const id = crypto.randomUUID();
  const opacity = isFiniteNumber(raw.opacity)
    ? Math.min(1, Math.max(0, raw.opacity))
    : 1;
  const visible = raw.visible !== false;

  switch (raw.type) {
    case 'color':
      if (typeof raw.color !== 'string') return null;
      return { id, type: 'color', color: raw.color, opacity, visible };
    case 'gradient': {
      if (!Array.isArray(raw.stops) || !isFiniteNumber(raw.angle)) return null;
      const stops = raw.stops.filter(
        (s): s is GradientStop =>
          isRecord(s) && isFiniteNumber(s.offset) && typeof s.color === 'string',
      );
      if (stops.length < 2) return null;
      return {
        id,
        type: 'gradient',
        stops: stops.map((s) => ({ offset: s.offset, color: s.color })),
        angle: raw.angle,
        opacity,
        visible,
      };
    }
    case 'shape': {
      const transform = toCell(raw.transform);
      if (
        !transform ||
        typeof raw.color !== 'string' ||
        !isShapeKind(raw.shape)
      ) {
        return null;
      }
      const layer: ShapeLayer = {
        id,
        type: 'shape',
        shape: raw.shape,
        color: raw.color,
        transform,
        opacity,
        visible,
      };
      if (isFiniteNumber(raw.cornerRadius) && raw.cornerRadius > 0) {
        layer.cornerRadius = raw.cornerRadius;
      }
      return floorLayerNumbers(layer);
    }
    case 'image': {
      if (typeof raw.file !== 'string' || !isImageFit(raw.fit)) return null;
      const bytes = readBytes(pack, raw.file);
      if (!bytes) return null;
      const mimeType =
        typeof raw.mimeType === 'string' ? raw.mimeType : 'image/png';
      const transform = toCell(raw.transform);
      const crop = toCell(raw.crop);
      const layer: ImageLayer = {
        id,
        type: 'image',
        source: { kind: 'inline', bytes, mimeType },
        fit: raw.fit,
        opacity,
        visible,
      };
      if (transform) layer.transform = transform;
      if (crop) layer.crop = crop;
      if (typeof raw.originalFileName === 'string') {
        layer.originalFileName = raw.originalFileName;
      }
      if (isRecord(raw.adjust)) {
        // 範囲外・欠けた値は floorLayerNumbers が範囲内／0（無補正）に揃える
        const rawAdjust = raw.adjust;
        const adjust = { lightness: 0, saturation: 0, hue: 0, blur: 0 };
        for (const key of IMAGE_ADJUST_KEYS) {
          const v = rawAdjust[key];
          if (isFiniteNumber(v)) adjust[key] = v;
        }
        layer.adjust = adjust;
      }
      return floorLayerNumbers(layer);
    }
    default:
      return null;
  }
}

// ===========================================================================
// ユーティリティ
// ===========================================================================

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isShapeKind(v: unknown): v is ShapeKind {
  return SHAPE_KINDS.some((k) => k === v);
}

function isImageFit(v: unknown): v is ImageLayer['fit'] {
  return v === 'stretch' || v === 'cover' || v === 'contain' || v === 'manual';
}

function toCell(v: unknown): AreaCell | null {
  if (!isRecord(v)) return null;
  const { x, y, width, height } = v;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isPositiveNumber(width) ||
    !isPositiveNumber(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}
