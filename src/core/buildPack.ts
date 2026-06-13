/**
 * buildPack — WallState から VirtualPack を構成する純関数。
 * 仕様: REWRITE_SPEC.md 第4.2章 / 第6章。
 *
 * 制約:
 *  - 音声変換は含めない。`WallState` に保持済みの変換済み ogg バイトをそのまま書く（第7.3章）。
 *  - 内部フラグ（`useGrid` / `show`）はエクスポート時に strip する（第6.3.2章）。
 *  - 座標・サイズは Math.floor で整数化済みの値だけを出力する（第6.3.1章）。
 *  - Canvas/`toBlob` を背景 PNG 生成で使うため async。**ブラウザ/Tauri webview 専用**、Node では動かさない。
 *  - BinaryRef は `inline`（バイト直持ち）のみ受け付ける。`ref` は永続化済みの参照で、
 *    adapter 側で resolve して inline に戻してから buildPack を呼ぶ責務。
 */

import { floorArea, floorCell, floorInt } from './coords';
import { renderBackgroundToCanvas } from './renderBackground';
import {
  SOUND_EVENT_KEYS,
  type AreaCell,
  type BinaryRef,
  type MainArea,
  type SoundEntry,
  type VisibleArea,
  type WallState,
} from './state';
import {
  PACK_FORMAT,
  PACK_PATHS,
  PLACEHOLDER_LOCK_SIZE,
  type VirtualPack,
} from './types';

// ===========================================================================
// 出力 JSON の型（custom_layout.json / sounds.json の最終形）
// `any` を使わないため、出力側の構造を型として定義する。
// ===========================================================================

interface GroupOutput {
  x: number;
  y: number;
  width: number;
  height: number;
  rows?: number;
  columns?: number;
  positions?: AreaCell[];
  padding?: number;
  cosmetic?: boolean;
  instance_background?: boolean;
  instance_overlay?: boolean;
}

interface LayoutOutput {
  main: GroupOutput;
  locked?: GroupOutput;
  preparing?: GroupOutput | GroupOutput[];
  replaceLockedInstances: boolean;
  mainFillOrder?: 'FORWARD' | 'BACKWARD' | 'RANDOM';
}

interface SoundEventOutput {
  replace: true;
  sounds: string[];
}

type SoundsJsonOutput = Record<string, SoundEventOutput>;

// ===========================================================================
// 公開 API
// ===========================================================================

export async function buildPack(state: WallState): Promise<VirtualPack> {
  const pack: VirtualPack = new Map();

  // 1) pack.mcmeta
  pack.set(
    PACK_PATHS.packMcmeta,
    JSON.stringify(
      {
        pack: {
          pack_format: PACK_FORMAT,
          description: state.packInfo.description,
        },
      },
      null,
      2,
    ),
  );

  // 2) pack.png（アイコンがあれば）
  if (state.packInfo.icon) {
    pack.set(PACK_PATHS.packPng, resolveInline(state.packInfo.icon));
  }

  // 3) custom_layout.json
  pack.set(PACK_PATHS.customLayout, buildCustomLayoutJson(state));

  // 4) background.png（visible なレイヤが 1 つ以上あれば）
  const backgroundPng = await renderBackgroundPng(state);
  if (backgroundPng) {
    pack.set(`${PACK_PATHS.texturesGuiWall}/background.png`, backgroundPng);
  }

  // 5) overlay / instance_background / instance_overlay（任意・第6.4章）
  const extras = state.extraTextures;
  if (extras.overlay) {
    pack.set(
      `${PACK_PATHS.texturesGuiWall}/overlay.png`,
      resolveInline(extras.overlay),
    );
  }
  if (extras.instance_background) {
    pack.set(
      `${PACK_PATHS.texturesGuiWall}/instance_background.png`,
      resolveInline(extras.instance_background),
    );
  }
  if (extras.instance_overlay) {
    pack.set(
      `${PACK_PATHS.texturesGuiWall}/instance_overlay.png`,
      resolveInline(extras.instance_overlay),
    );
  }

  // 6) lock 画像（第6.5章）
  await addLockImages(pack, state);

  // 7) sounds.json + ogg ファイル（第6.6章）
  addSounds(pack, state);

  return pack;
}

// ===========================================================================
// custom_layout.json
// ===========================================================================

function buildCustomLayoutJson(state: WallState): string {
  const layout: LayoutOutput = {
    main: buildGroup(state.layout.main, { isMain: true }),
    replaceLockedInstances: state.replaceLockedInstances,
  };

  if (
    state.layout.main.mainFillOrder &&
    state.layout.main.mainFillOrder !== 'FORWARD'
  ) {
    layout.mainFillOrder = state.layout.main.mainFillOrder;
  }

  if (state.layout.locked.show) {
    layout.locked = buildGroup(state.layout.locked, { isMain: false });
  }

  const visiblePreparing = state.layout.preparing.filter((p) => p.show);
  if (visiblePreparing.length === 1) {
    layout.preparing = buildGroup(visiblePreparing[0], { isMain: false });
  } else if (visiblePreparing.length > 1) {
    layout.preparing = visiblePreparing.map((p) =>
      buildGroup(p, { isMain: false }),
    );
  }

  return JSON.stringify(layout, null, 2);
}

function buildGroup(
  area: MainArea | VisibleArea,
  opts: { isMain: boolean },
): GroupOutput {
  const f = floorArea(area);
  const g: GroupOutput = {
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
  };

  // useGrid=false かつ positions があれば positions 方式、それ以外は rows/columns
  if (area.useGrid === false && area.positions && area.positions.length > 0) {
    g.positions = area.positions.map((p) => floorCell(p));
  } else {
    g.rows = floorInt(area.rows);
    g.columns = floorInt(area.columns);
  }

  if (area.padding !== undefined && area.padding > 0) {
    g.padding = floorInt(area.padding);
  }

  // 機能拡充候補（値が指定されているときだけ出力）
  if (!opts.isMain && area.cosmetic === true) {
    g.cosmetic = true;
  }
  if (area.instance_background === false) {
    g.instance_background = false;
  }
  if (area.instance_overlay === false) {
    g.instance_overlay = false;
  }

  return g;
}

// ===========================================================================
// background.png（Canvas 合成）
// ===========================================================================

async function renderBackgroundPng(
  state: WallState,
): Promise<Uint8Array | null> {
  const visibleLayers = state.background.layers.filter((l) => l.visible);
  if (visibleLayers.length === 0) {
    return null;
  }
  const canvas = createCanvas(state.resolution.width, state.resolution.height);
  await renderBackgroundToCanvas(canvas, state.background, state.resolution);
  return canvasToPngBytes(canvas);
}

// ===========================================================================
// lock 画像
// - enabled=false:                       透明 128x128 を lock.png として出力（MOD 既定の上書き）
// - enabled=true, images.length===0:     何も出さない（MOD 既定にフォールバック）
// - enabled=true, images.length>0:       1 枚目=lock.png、以降 lock-1.png, lock-2.png, ...
// ===========================================================================

async function addLockImages(
  pack: VirtualPack,
  state: WallState,
): Promise<void> {
  if (!state.lockImages.enabled) {
    pack.set(
      `${PACK_PATHS.texturesGuiWall}/lock.png`,
      await transparentPngBytes(PLACEHOLDER_LOCK_SIZE, PLACEHOLDER_LOCK_SIZE),
    );
    return;
  }
  if (state.lockImages.images.length === 0) {
    return;
  }
  state.lockImages.images.forEach((img, i) => {
    const filename = i === 0 ? 'lock.png' : `lock-${i}.png`;
    pack.set(
      `${PACK_PATHS.texturesGuiWall}/${filename}`,
      resolveInline(img.source),
    );
  });
}

// lock 無効化時の透明プレースホルダはサイズ固定（PLACEHOLDER_LOCK_SIZE）かつ常に同じバイト列。
// 初回だけ生成して再利用する（毎回 Canvas + convertToBlob を回さない）。
let _transparentPngPromise: Promise<Uint8Array> | null = null;
async function transparentPngBytes(
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (width === PLACEHOLDER_LOCK_SIZE && height === PLACEHOLDER_LOCK_SIZE) {
    if (!_transparentPngPromise) {
      const canvas = createCanvas(width, height);
      _transparentPngPromise = canvasToPngBytes(canvas);
    }
    return _transparentPngPromise;
  }
  const canvas = createCanvas(width, height);
  return canvasToPngBytes(canvas);
}

// ===========================================================================
// sounds.json + ogg
// 第6.6章：default=書かない / off={replace:true,sounds:[]} / custom={replace:true,sounds:["<event>.ogg"]}+ogg配置
// globalMode='off' は per-event 設定に関わらず全 13 イベントを off 扱いで出力。
// ===========================================================================

function addSounds(pack: VirtualPack, state: WallState): void {
  const soundsJson: SoundsJsonOutput = {};
  const globalOff = state.sounds.globalMode === 'off';

  for (const event of SOUND_EVENT_KEYS) {
    const entry: SoundEntry = globalOff
      ? { mode: 'off' }
      : state.sounds.events[event];

    if (entry.mode === 'default') {
      continue;
    }
    if (entry.mode === 'off') {
      soundsJson[event] = { replace: true, sounds: [] };
      continue;
    }
    // custom
    soundsJson[event] = { replace: true, sounds: [`${event}.ogg`] };
    pack.set(
      `${PACK_PATHS.sounds}/${event}.ogg`,
      resolveInline(entry.ogg),
    );
  }

  if (Object.keys(soundsJson).length > 0) {
    pack.set(PACK_PATHS.soundsJson, JSON.stringify(soundsJson, null, 2));
  }
}

// ===========================================================================
// 内部ユーティリティ
// ===========================================================================

function resolveInline(ref: BinaryRef): Uint8Array {
  if (ref.kind === 'inline') {
    return ref.bytes;
  }
  throw new Error(
    `buildPack: received unresolved BinaryRef (storageKey=${ref.storageKey}). ` +
      'Adapter must resolve refs to inline bytes before calling buildPack.',
  );
}

/**
 * `OffscreenCanvas` を使うことで main thread / Web Worker のどちらでも同じコードで動かせる。
 * OffscreenCanvas は Chrome/Edge/Safari/Firefox いずれもサポート済み。
 * Tauri webview（WebView2 / WKWebView）も対応している。
 */
function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

async function canvasToPngBytes(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

