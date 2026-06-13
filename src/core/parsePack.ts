/**
 * parsePack — VirtualPack から WallState を復元する純関数。
 * 仕様: REWRITE_SPEC.md 第5章 / 第7.1章 / 第8章 (#5〜#8 の旧バグ対応)。
 *
 * 設計:
 *  - **buildPack と対称**：buildPack が strip した内部フラグ（useGrid / show）を、
 *    エクスポート形式から復元する。
 *  - 背景は1枚の `ImageLayer`（fit='stretch'）として復元する。
 *    色レイヤ・グラデーション情報は背景 PNG として焼き込まれているため、構造的には復元不能。
 *    旧アプリの "imageLayers" 不整合バグ（第8章 #5）を避けるため、必ず `background.layers` に載せる。
 *  - **解像度は呼び出し側で指定する**：SeedQueue パックフォーマットは framebuffer 解像度を
 *    保持しないため、何 px を想定したパックかは呼び出し側が決定する。
 *    `background.png` のサイズが妥当な推定値になるため、`detectBackgroundResolution`
 *    で取り出して UI 側のデフォルト値に使う運用を想定。
 *  - sounds: `sounds.json` 不在のイベントは `mode: 'default'`、`replace=true, sounds=[]` は `off`、
 *    `sounds=["<event>.ogg"]` は対応 ogg を読み込んで `custom` に。
 *  - lock 画像: 1 枚目=`lock.png`、以降 `lock-1.png` `lock-2.png` …。
 *  - 不正/欠損ファイルは安全側にフォールバックし、致命的でない限り例外を投げない。
 *    `custom_layout.json` が欠損または parse 不能なときだけ throw する（SeedQueue パックではない）。
 *
 * 不変条件:
 *  - 出力 WallState は座標が整数化されていること（buildPack と対称の保証）。
 *  - rows/columns は 1 以上の整数。
 *  - 背景レイヤ id は新規発行（旧 id は import 元に依存しない）。
 */

import { floorArea, floorCell, floorInt } from './coords';
import { errMsg } from './errors';
import {
  SOUND_EVENT_KEYS,
  createDefaultWallState,
  type AreaCell,
  type BackgroundLayer,
  type LockImage,
  type MainArea,
  type Resolution,
  type SoundEntry,
  type SoundEventKey,
  type VisibleArea,
  type WallState,
} from './state';
import { PACK_FORMAT, PACK_PATHS, type VirtualPack } from './types';

// ===========================================================================
// オプション
// ===========================================================================

export interface ParsePackOptions {
  /**
   * 復元後の `WallState.resolution`。
   * SeedQueue パックには明示的な解像度がないため、呼び出し側で必ず指定する。
   * `detectBackgroundResolution` で得た値をデフォルトに使うのが推奨。
   */
  resolution: Resolution;
}

// ===========================================================================
// 入力 JSON の型（custom_layout.json / sounds.json の最小受入形）
// パース時は実行時バリデーションで narrow するため optional。
// ===========================================================================

interface RawGroup {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  rows?: unknown;
  columns?: unknown;
  positions?: unknown;
  padding?: unknown;
  cosmetic?: unknown;
  instance_background?: unknown;
  instance_overlay?: unknown;
}

interface RawLayout {
  main?: unknown;
  locked?: unknown;
  preparing?: unknown;
  replaceLockedInstances?: unknown;
  mainFillOrder?: unknown;
}

interface RawSoundEvent {
  replace?: unknown;
  sounds?: unknown;
}

type RawSoundsJson = Record<string, RawSoundEvent>;

// ===========================================================================
// 公開 API
// ===========================================================================

export async function parsePack(
  pack: VirtualPack,
  options: ParsePackOptions,
): Promise<WallState> {
  const defaults = createDefaultWallState();

  // 1) pack.mcmeta（description）
  const description = readDescription(pack) ?? defaults.packInfo.description;

  // 2) pack.png（icon）
  const iconBytes = readBytes(pack, PACK_PATHS.packPng);
  const icon = iconBytes
    ? ({ kind: 'inline' as const, bytes: iconBytes, mimeType: 'image/png' })
    : null;

  // 3) custom_layout.json（必須）
  const layoutText = readString(pack, PACK_PATHS.customLayout);
  if (!layoutText) {
    throw new Error(
      'parsePack: custom_layout.json が見つかりません（SeedQueue パックではない可能性があります）',
    );
  }
  let rawLayout: RawLayout;
  try {
    rawLayout = JSON.parse(layoutText) as RawLayout;
  } catch (e) {
    throw new Error(
      `parsePack: custom_layout.json を解析できませんでした: ${errMsg(e)}`,
    );
  }

  // 4) 解像度（呼び出し側指定・必ず正の整数に正規化）
  const resolution: Resolution = {
    width: Math.max(1, floorInt(options.resolution.width)),
    height: Math.max(1, floorInt(options.resolution.height)),
  };

  // 5) 背景レイヤ復元（1 枚の image layer として）
  const backgroundPath = `${PACK_PATHS.texturesGuiWall}/background.png`;
  const backgroundBytes = readBytes(pack, backgroundPath);
  const backgroundLayers: BackgroundLayer[] = backgroundBytes
    ? [
        {
          id: crypto.randomUUID(),
          type: 'image',
          source: {
            kind: 'inline',
            bytes: backgroundBytes,
            mimeType: 'image/png',
          },
          opacity: 1,
          visible: true,
          fit: 'stretch',
          originalFileName: 'background.png',
        },
      ]
    : [];

  // 6) layout
  const main = parseMain(rawLayout.main, rawLayout.mainFillOrder);
  const locked = parseLocked(rawLayout.locked);
  const preparing = parsePreparing(rawLayout.preparing);
  const replaceLockedInstances = rawLayout.replaceLockedInstances === true;

  // 7) extra textures
  const extras: WallState['extraTextures'] = {};
  const overlayBytes = readBytes(
    pack,
    `${PACK_PATHS.texturesGuiWall}/overlay.png`,
  );
  if (overlayBytes) {
    extras.overlay = {
      kind: 'inline',
      bytes: overlayBytes,
      mimeType: 'image/png',
    };
  }
  const ibBytes = readBytes(
    pack,
    `${PACK_PATHS.texturesGuiWall}/instance_background.png`,
  );
  if (ibBytes) {
    extras.instance_background = {
      kind: 'inline',
      bytes: ibBytes,
      mimeType: 'image/png',
    };
  }
  const ioBytes = readBytes(
    pack,
    `${PACK_PATHS.texturesGuiWall}/instance_overlay.png`,
  );
  if (ioBytes) {
    extras.instance_overlay = {
      kind: 'inline',
      bytes: ioBytes,
      mimeType: 'image/png',
    };
  }

  // 8) lock 画像
  const lockImages = parseLockImages(pack);

  // 9) sounds
  const sounds = parseSounds(pack);

  // 10) pack_format の警告（非致命）
  warnPackFormatMismatch(pack);

  const state: WallState = {
    resolution,
    layout: { main, locked, preparing },
    background: { layers: backgroundLayers },
    extraTextures: extras,
    packInfo: {
      name: defaults.packInfo.name,
      description,
      icon,
    },
    sounds,
    lockImages,
    replaceLockedInstances,
  };

  return state;
}

// ===========================================================================
// pack.mcmeta / pack_format
// ===========================================================================

function readDescription(pack: VirtualPack): string | null {
  const text = readString(pack, PACK_PATHS.packMcmeta);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as {
      pack?: { description?: unknown };
    };
    const d = parsed.pack?.description;
    return typeof d === 'string' ? d : null;
  } catch {
    return null;
  }
}

function warnPackFormatMismatch(pack: VirtualPack): void {
  const text = readString(pack, PACK_PATHS.packMcmeta);
  if (!text) return;
  try {
    const parsed = JSON.parse(text) as {
      pack?: { pack_format?: unknown };
    };
    const f = parsed.pack?.pack_format;
    if (typeof f === 'number' && f !== PACK_FORMAT) {
      console.warn(
        `parsePack: pack_format=${f} は SeedQueue 想定 (${PACK_FORMAT}) と異なります`,
      );
    }
  } catch {
    // ignore
  }
}

// ===========================================================================
// layout
// ===========================================================================

function parseMain(
  rawMain: unknown,
  rawFillOrder: unknown,
): MainArea {
  const defaults = createDefaultWallState().layout.main;
  if (!isRecord(rawMain)) return defaults;
  const base = parseArea(rawMain) ?? defaults;
  const order = parseFillOrder(rawFillOrder);
  return {
    ...base,
    mainFillOrder: order,
  };
}

function parseLocked(rawLocked: unknown): VisibleArea {
  const defaults = createDefaultWallState().layout.locked;
  if (!isRecord(rawLocked)) {
    // locked が無い ⇒ show=false で defaults を使う
    return { ...defaults, show: false };
  }
  const base = parseArea(rawLocked) ?? defaults;
  return { ...base, show: true };
}

function parsePreparing(rawPreparing: unknown): VisibleArea[] {
  if (rawPreparing === undefined || rawPreparing === null) return [];
  // SeedQueue は単一オブジェクトと配列の両方を受ける
  if (Array.isArray(rawPreparing)) {
    const out: VisibleArea[] = [];
    for (const item of rawPreparing) {
      if (!isRecord(item)) continue;
      const base = parseArea(item);
      if (base) out.push({ ...base, show: true });
    }
    return out;
  }
  if (isRecord(rawPreparing)) {
    const base = parseArea(rawPreparing);
    if (base) return [{ ...base, show: true }];
  }
  return [];
}

/**
 * 共通 Area パース。x/y/width/height は必須。
 * positions があれば useGrid=false、無ければ useGrid=true で rows/columns を読む。
 * 失敗時は null。呼び出し側で default にフォールバックする。
 */
function parseArea(
  raw: RawGroup,
): (MainArea & VisibleArea) | null {
  const x = toFiniteNumber(raw.x);
  const y = toFiniteNumber(raw.y);
  const width = toFiniteNumber(raw.width);
  const height = toFiniteNumber(raw.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  const positions = parsePositions(raw.positions);
  const useGrid = positions === null;
  const rows = useGrid ? Math.max(1, toIntOr(raw.rows, 1)) : 1;
  const columns = useGrid ? Math.max(1, toIntOr(raw.columns, 1)) : 1;
  const padding = Math.max(0, toIntOr(raw.padding, 0));

  const area = floorArea({
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
    rows,
    columns,
    useGrid,
    padding,
    // VisibleArea / MainArea の追加フィールドは呼び出し側で付与
    show: true,
  });

  // 任意キー
  const result: MainArea & VisibleArea = { ...area };
  if (!useGrid && positions && positions.length > 0) {
    result.positions = positions;
  }
  if (raw.cosmetic === true) {
    result.cosmetic = true;
  }
  if (raw.instance_background === false) {
    result.instance_background = false;
  }
  if (raw.instance_overlay === false) {
    result.instance_overlay = false;
  }
  return result;
}

function parsePositions(raw: unknown): AreaCell[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AreaCell[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const x = toFiniteNumber(item.x);
    const y = toFiniteNumber(item.y);
    const w = toFiniteNumber(item.width);
    const h = toFiniteNumber(item.height);
    if (x === null || y === null || w === null || h === null) continue;
    out.push(floorCell({ x, y, width: w, height: h }));
  }
  return out.length > 0 ? out : null;
}

function parseFillOrder(
  raw: unknown,
): 'FORWARD' | 'BACKWARD' | 'RANDOM' | undefined {
  if (raw === 'FORWARD' || raw === 'BACKWARD' || raw === 'RANDOM') {
    return raw;
  }
  return undefined;
}

// ===========================================================================
// lock 画像
// ===========================================================================

function parseLockImages(pack: VirtualPack): WallState['lockImages'] {
  const images: LockImage[] = [];
  const first = readBytes(pack, `${PACK_PATHS.texturesGuiWall}/lock.png`);
  if (!first) {
    // lock.png が無ければ enabled=false / images=[]（SeedQueue 既定にフォールバック）
    return { enabled: false, images: [] };
  }
  images.push({
    id: crypto.randomUUID(),
    source: { kind: 'inline', bytes: first, mimeType: 'image/png' },
    originalFileName: 'lock.png',
  });

  // lock-1.png, lock-2.png, ... を連番で探す
  for (let i = 1; i < 256; i++) {
    const path = `${PACK_PATHS.texturesGuiWall}/lock-${i}.png`;
    const bytes = readBytes(pack, path);
    if (!bytes) break;
    images.push({
      id: crypto.randomUUID(),
      source: { kind: 'inline', bytes, mimeType: 'image/png' },
      originalFileName: `lock-${i}.png`,
    });
  }
  return { enabled: true, images };
}

// ===========================================================================
// sounds
// ===========================================================================

function parseSounds(pack: VirtualPack): WallState['sounds'] {
  const defaults = createDefaultWallState().sounds;
  const text = readString(pack, PACK_PATHS.soundsJson);
  if (!text) return defaults;

  let raw: RawSoundsJson;
  try {
    raw = JSON.parse(text) as RawSoundsJson;
  } catch {
    return defaults;
  }
  if (!isRecord(raw)) return defaults;

  const events = { ...defaults.events };
  let anyOff = true;
  let anyNonOff = false;

  for (const key of SOUND_EVENT_KEYS) {
    const e = raw[key];
    if (!isRecord(e)) continue;
    const sounds = e.sounds;
    if (e.replace !== true || !Array.isArray(sounds)) continue;

    if (sounds.length === 0) {
      events[key] = { mode: 'off' };
    } else {
      // 期待する形は ["<event>.ogg"] 1 要素。先頭の文字列を採用。
      const filename = typeof sounds[0] === 'string' ? sounds[0] : null;
      if (!filename) continue;
      const oggBytes = readBytes(
        pack,
        `${PACK_PATHS.sounds}/${filename}`,
      );
      if (!oggBytes) {
        // ファイルが見つからなければ default に倒す（壊れたパック対策）
        console.warn(
          `parsePack: ${key} で参照される ${filename} が見つかりませんでした`,
        );
        continue;
      }
      events[key] = {
        mode: 'custom',
        ogg: { kind: 'inline', bytes: oggBytes, mimeType: 'audio/ogg' },
        originalFileName: filename,
      };
      anyNonOff = true;
    }
  }

  for (const key of SOUND_EVENT_KEYS) {
    if (events[key].mode !== 'off') anyOff = false;
  }

  // resetUnified は全 reset 系が同じ entry に揃っていれば true、そうでなければ false。
  const resetUnified = areResetEventsUnified(events);

  return {
    globalMode: anyOff && !anyNonOff ? 'off' : 'custom',
    resetUnified,
    events,
  };
}

function areResetEventsUnified(
  events: Record<SoundEventKey, SoundEntry>,
): boolean {
  const keys: SoundEventKey[] = [
    'reset_instance',
    'reset_all',
    'reset_column',
    'reset_row',
  ];
  const ref = entrySignature(events[keys[0]]);
  return keys.every((k) => entrySignature(events[k]) === ref);
}

/** 比較用のシグネチャ（簡易）。バイト同一性は要求しない。 */
function entrySignature(entry: SoundEntry): string {
  switch (entry.mode) {
    case 'default':
      return 'default';
    case 'off':
      return 'off';
    case 'custom':
      return `custom:${entry.originalFileName ?? ''}`;
  }
}

// ===========================================================================
// 解像度検出
// SeedQueue パックは framebuffer 解像度を保持しないが、`background.png` のサイズが
// 妥当な推定値になる（buildPack はこのサイズで生成しているため）。
// 復元時のデフォルト値として UI 側で利用する。
// ===========================================================================

/**
 * `background.png` のサイズから解像度を推定する。
 *  - 背景 PNG が無い場合は `null`。
 *  - decode 失敗時も `null`。
 */
export async function detectBackgroundResolution(
  pack: VirtualPack,
): Promise<Resolution | null> {
  const bytes = readBytes(pack, `${PACK_PATHS.texturesGuiWall}/background.png`);
  if (!bytes) return null;
  try {
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const result: Resolution = {
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close?.();
    return result;
  } catch (e) {
    console.warn('detectBackgroundResolution: decode failed', e);
    return null;
  }
}

// ===========================================================================
// 汎用ユーティリティ
// ===========================================================================

function readBytes(pack: VirtualPack, path: string): Uint8Array | null {
  const v = pack.get(path);
  if (v === undefined) return null;
  if (typeof v === 'string') return null; // JSON テキスト相手にこの API は使わない
  return v;
}

function readString(pack: VirtualPack, path: string): string | null {
  const v = pack.get(path);
  if (v === undefined) return null;
  if (typeof v === 'string') return v;
  // Uint8Array の場合は UTF-8 として decode（VirtualPack 内に JSON がバイナリで入っているケース）
  try {
    return new TextDecoder('utf-8').decode(v);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toIntOr(v: unknown, fallback: number): number {
  const n = toFiniteNumber(v);
  return n === null ? fallback : floorInt(n);
}
