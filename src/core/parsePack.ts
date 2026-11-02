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
 *    ただし本アプリが同梱した編集データ（`wall-maker/background.json`、core/editorMeta.ts）が
 *    読めれば、そちらからレイヤ構成を復元する（background.png より優先）。
 *  - **解像度は呼び出し側で指定する**：SeedQueue パックフォーマットは framebuffer 解像度を
 *    保持しないため、何 px を想定したパックかは呼び出し側が決定する。
 *    `background.png` のサイズが妥当な推定値になるため、`detectBackgroundResolution`
 *    で取り出して UI 側のデフォルト値に使う運用を想定。
 *  - sounds: `sounds.json` 不在のイベントは `mode: 'default'`、`replace=true` で空は `off`、
 *    無音 ogg（`seedqueue:custom/silent`）も `off`。参照先の ogg がパック内にあれば `custom`
 *    （現行の `seedqueue:custom/<event>`、v3.4.0 以前の `seedqueue:<event>`、`<event>` /
 *    `<event>.ogg` も可）。パック内に無く `seedqueue:reset_instance` / `seedqueue:lock_instance` を
 *    指していれば mod 内蔵音（`builtin`）。`replace` 省略・オブジェクト形式の要素も読む。
 *    表せない／再生できない参照は default に倒し、`onSoundIssue` で通知する（`parseSoundEvent`）。
 *  - lock 画像: 1 枚目=`lock.png`、以降 `lock-1.png` `lock-2.png` …。
 *  - 不正/欠損ファイルは安全側にフォールバックし、致命的でない限り例外を投げない。
 *    `custom_layout.json` が欠損または parse 不能なときだけ throw する（SeedQueue パックではない）。
 *
 * 不変条件:
 *  - 出力 WallState は座標が整数化されていること（buildPack と対称の保証）。
 *  - x/y/width/height は SeedQueue 仕様どおり「小数点を含むリテラル＝framebuffer 割合」と解釈し、
 *    x/width は解像度幅・y/height は解像度高を乗じて絶対 px 化してから整数化する（第6.3.1章）。
 *    `1.0` と `1` の区別が必要なため判定は JSON.parse の source access で行う（`parseLayoutJson`）。
 *  - rows/columns は 1 以上の整数。
 *  - 背景レイヤ id は新規発行（旧 id は import 元に依存しない）。
 */

import { floorArea, floorCell, floorInt } from './coords';
import { parseEditorMeta, readEditorMetaResolution } from './editorMeta';
import { parseLockMcmeta } from './lockWeights';
import { errMsg } from './errors';
import { getDefaultPresetLayout } from './layoutPresets';
import { isPlayableOggVorbis } from './oggVorbis';
import {
  BUILTIN_SOUND_KEYS,
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
import {
  CUSTOM_SOUND_DIR,
  PACK_FORMAT,
  PACK_PATHS,
  SEEDQUEUE_NAMESPACE,
  SILENT_SOUND_FILE,
  type VirtualPack,
} from './types';

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
  /**
   * sounds.json のイベントを本アプリの設定で表せず、既定（default）に倒したときの通知。
   * インポート自体は継続する（非致命）。呼び出し側でユーザに知らせる用途。
   */
  onSoundIssue?: (issue: SoundImportIssue) => void;
}

/**
 * サウンド読込で既定に倒したイベントと理由。
 *  - `unresolved` : 参照先がパック内にも mod 内蔵音にも無い／他名前空間の音・
 *                   サウンドイベント参照（`type: "event"`）など、本アプリで表せない
 *  - `unplayable` : 参照先の ogg が Minecraft で再生できない（Opus・3ch 以上・破損）。
 *                   SeedQueue はこれでゲームをクラッシュさせるため取り込まない
 */
export interface SoundImportIssue {
  event: SoundEventKey;
  kind: 'unresolved' | 'unplayable';
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

  // 3) 解像度（呼び出し側指定・必ず正の整数に正規化）
  //    custom_layout.json の割合座標→絶対px 変換に使うため、layout パースより先に確定させる。
  const resolution: Resolution = {
    width: Math.max(1, floorInt(options.resolution.width)),
    height: Math.max(1, floorInt(options.resolution.height)),
  };

  // 4) custom_layout.json（必須）
  const layoutText = readString(pack, PACK_PATHS.customLayout);
  if (!layoutText) {
    throw new Error(
      'parsePack: custom_layout.json が見つかりません（SeedQueue パックではない可能性があります）',
    );
  }
  let rawLayout: RawLayout;
  try {
    rawLayout = parseLayoutJson(layoutText, resolution);
  } catch (e) {
    throw new Error(
      `parsePack: custom_layout.json を解析できませんでした: ${errMsg(e)}`,
    );
  }

  // 5) 背景レイヤ復元（編集データがあればレイヤ構成ごと、無ければ 1 枚の image layer として）
  const metaLayers = parseEditorMeta(pack, resolution);
  const backgroundPath = `${PACK_PATHS.texturesGuiWall}/background.png`;
  const backgroundBytes = readBytes(pack, backgroundPath);
  const backgroundLayers: BackgroundLayer[] = metaLayers
    ? metaLayers
    : backgroundBytes
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

  // 6) layout（座標は parseLayoutJson で絶対 px 変換済み）
  //    パース不能／省略されたグループのフォールバック矩形は、`createDefaultWallState()` の
  //    1920x1080 決め打ちではなく **正規化済み resolution** に合わせた既定プリセットから組む。
  //    2560x1440 のパックを locked 省略で読んだときに縮尺の合わない箱が復元されるのを防ぐ。
  const defaultLayout = getDefaultPresetLayout(resolution);
  const main = parseMain(
    rawLayout.main,
    rawLayout.mainFillOrder,
    defaultLayout.main,
  );
  const locked = parseLocked(rawLayout.locked, defaultLayout.locked);
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
  const lockImages = await parseLockImages(pack);

  // 9) sounds
  const sounds = parseSounds(pack, options.onSoundIssue);

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
      // 編集データ付きで書き出されたパックは、再保存でも同梱を続ける
      embedEditorData: metaLayers !== null,
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

/** 割合→絶対px 変換の対象キー。custom_layout.json 内では Group / position の座標にしか現れない。 */
const RATIO_WIDTH_KEYS: ReadonlySet<string> = new Set(['x', 'width']);
const RATIO_HEIGHT_KEYS: ReadonlySet<string> = new Set(['y', 'height']);

/**
 * custom_layout.json 専用の JSON.parse。
 *
 * SeedQueue の座標解釈（第6.3.1章）は**数値リテラルの表記**で決まる:
 * 小数点を含む表記（例 `0.85`、`1.0`）= framebuffer 割合 / 含まない（例 `1632`）= 絶対px。
 * JSON.parse 後の number では `1.0` と `1` が区別できないため、reviver の source access
 * （ES2023。Chromium 114+ / 近年の WebKit・Gecko が対応）でリテラル表記を見て、
 * 割合値はこの段階で絶対 px に変換する（小数のまま返し、floor は後段の floorArea に任せる）。
 * source access 非対応環境では Number.isInteger による近似判定にフォールバックする
 * （`1.0` 表記だけは絶対 1px と誤読するが、それ以外は同一挙動）。
 */
function parseLayoutJson(text: string, resolution: Resolution): RawLayout {
  const reviver = (
    key: string,
    value: unknown,
    context?: { source?: string },
  ): unknown => {
    if (typeof value !== 'number') return value;
    const isWidthAxis = RATIO_WIDTH_KEYS.has(key);
    const isHeightAxis = RATIO_HEIGHT_KEYS.has(key);
    if (!isWidthAxis && !isHeightAxis) return value;
    const source = context?.source;
    const isRatio =
      typeof source === 'string'
        ? source.includes('.') || !Number.isInteger(value)
        : !Number.isInteger(value);
    if (!isRatio) return value;
    return value * (isWidthAxis ? resolution.width : resolution.height);
  };
  return JSON.parse(
    text,
    reviver as (this: unknown, key: string, value: unknown) => unknown,
  ) as RawLayout;
}

function parseMain(
  rawMain: unknown,
  rawFillOrder: unknown,
  defaults: MainArea,
): MainArea {
  if (!isRecord(rawMain)) return defaults;
  const base = parseArea(rawMain, { isMain: true }) ?? defaults;
  const order = parseFillOrder(rawFillOrder);
  // rows/columns を省略した main（useGrid=false）は JSON 側に分割数が存在しないため、
  // parseArea が入れる暫定値は 1x1 になる。そのままだとユーザがグリッドを ON に戻した瞬間に
  // 1 インスタンスだけの壁になるので、「戻したときの初期値」として既定プリセットの分割数を入れる。
  // useGrid=false のままなら buildPack は rows/columns を出力しないので、出力には影響しない。
  const gridFallback =
    base.useGrid === false && base.positions === undefined
      ? { rows: defaults.rows, columns: defaults.columns }
      : {};
  return {
    ...base,
    ...gridFallback,
    mainFillOrder: order,
  };
}

function parseLocked(rawLocked: unknown, defaults: VisibleArea): VisibleArea {
  if (!isRecord(rawLocked)) {
    // locked が無い ⇒ show=false で defaults を使う
    return { ...defaults, show: false };
  }
  const base = parseArea(rawLocked, { isMain: false }) ?? defaults;
  return { ...base, show: true };
}

function parsePreparing(rawPreparing: unknown): VisibleArea[] {
  if (rawPreparing === undefined || rawPreparing === null) return [];
  // SeedQueue は単一オブジェクトと配列の両方を受ける
  if (Array.isArray(rawPreparing)) {
    const out: VisibleArea[] = [];
    for (const item of rawPreparing) {
      if (!isRecord(item)) continue;
      const base = parseArea(item, { isMain: false });
      if (base) out.push({ ...base, show: true });
    }
    return out;
  }
  if (isRecord(rawPreparing)) {
    const base = parseArea(rawPreparing, { isMain: false });
    if (base) return [{ ...base, show: true }];
  }
  return [];
}

/**
 * 共通 Area パース。x/y/width/height は必須。
 * positions があれば useGrid=false、無ければ rows/columns を読んで useGrid=true。
 * ただし **main で rows/columns が両方とも欠けている** ときは、buildPack の
 * 「useGrid=false の main は rows/columns を出さない」出力と対称になるよう useGrid=false に倒す
 * （そうしないと自作パックの再インポートで 1x1 グリッドに化ける）。
 * locked/preparing は仕様上 rows/columns が必須なので、欠落していてもグリッド扱いのまま既定 1 で復元し、
 * 再エクスポートで仕様準拠の JSON に戻す。
 * 失敗時は null。呼び出し側で default にフォールバックする。
 */
function parseArea(
  raw: RawGroup,
  opts: { isMain: boolean },
): (MainArea & VisibleArea) | null {
  const x = toFiniteNumber(raw.x);
  const y = toFiniteNumber(raw.y);
  const width = toFiniteNumber(raw.width);
  const height = toFiniteNumber(raw.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  const positions = parsePositions(raw.positions);
  const hasGridCounts =
    toFiniteNumber(raw.rows) !== null || toFiniteNumber(raw.columns) !== null;
  const useGrid = positions === null && (hasGridCounts || !opts.isMain);
  const rows = Math.max(1, toIntOr(raw.rows, 1));
  const columns = Math.max(1, toIntOr(raw.columns, 1));
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
    // parseArea の width/height と同じく最低 1px を保証する。
    // 割合表記は parseLayoutJson の reviver で絶対 px 化済みだが、極端に小さい割合
    // （低解像度での `width: 0.0005` など）や 0 が直接書かれたセルは floor で 0 に潰れ、
    // そのまま再エクスポートされてしまうため。
    out.push(
      floorCell({ x, y, width: Math.max(1, w), height: Math.max(1, h) }),
    );
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

async function parseLockImages(
  pack: VirtualPack,
): Promise<WallState['lockImages']> {
  const images: LockImage[] = [];
  const first = readBytes(pack, `${PACK_PATHS.texturesGuiWall}/lock.png`);
  if (!first) {
    // lock.png が無い ＝ MOD 既定の lock にフォールバックする状態。
    // buildPack の対称は「enabled=true・images=[]（何も出力しない）」。
    // enabled=false と誤って復元すると、再エクスポートで透明 lock.png が付与され
    // ゲーム内のロックアイコンが消えてしまう（buildPack との非対称）。
    return { enabled: true, images: [] };
  }

  // `.mcmeta` の seedqueue セクション（重み）と、それ以外（animation など）を取り出す。
  // defaultWeight は SeedQueue が lock.png からしか読まないので 1 枚目だけ見る。
  const readMeta = (filename: string) =>
    parseLockMcmeta(
      readString(pack, `${PACK_PATHS.texturesGuiWall}/${filename}.mcmeta`) ??
        undefined,
    );

  const firstMeta = readMeta('lock.png');
  images.push({
    id: crypto.randomUUID(),
    source: { kind: 'inline', bytes: first, mimeType: 'image/png' },
    originalFileName: 'lock.png',
    ...(firstMeta.weight !== undefined ? { weight: firstMeta.weight } : {}),
    ...(firstMeta.extra ? { mcmetaExtra: firstMeta.extra } : {}),
  });

  // lock-1.png, lock-2.png, ... を連番で探す
  for (let i = 1; i < 256; i++) {
    const filename = `lock-${i}.png`;
    const bytes = readBytes(pack, `${PACK_PATHS.texturesGuiWall}/${filename}`);
    if (!bytes) break;
    const meta = readMeta(filename);
    images.push({
      id: crypto.randomUUID(),
      source: { kind: 'inline', bytes, mimeType: 'image/png' },
      originalFileName: filename,
      ...(meta.weight !== undefined ? { weight: meta.weight } : {}),
      ...(meta.extra ? { mcmetaExtra: meta.extra } : {}),
    });
  }

  const defaultWeight = firstMeta.defaultWeight;

  // buildPack はロック無効時に「全ピクセル透明の lock.png 1 枚だけ」を出力する（第6.5章）。
  // その形（透明 lock.png 単独）のときに限り enabled=false として復元する。
  // 透明 lock.png ＋ lock-1.png… の併用は「一部インスタンスだけロック非表示」という
  // 正当な構成なので、全画像を保持して通常どおり enabled=true にする。
  // 検査失敗時も通常画像として扱う（安全側フォールバック）。
  if (images.length === 1 && (await isFullyTransparentImage(first))) {
    return { enabled: false, images: [] };
  }

  return {
    enabled: true,
    images,
    ...(defaultWeight !== undefined ? { defaultWeight } : {}),
  };
}

/**
 * 全画素走査を許す最大辺長。これを超える画像は走査せず「透明ではない」と判定する。
 *
 * この検査が本来判別したいのは buildPack が書く透明プレースホルダ
 * （PLACEHOLDER_LOCK_SIZE = 128x128）と、手書きパックの同等物だけ。
 * 上限なしだと 4096x4096 の lock.png で 67MB の ImageData と 1670 万回のループが
 * import 中のメインスレッドで走るため、辺長で打ち切る（1024x1024 で ImageData 4MB）。
 *
 * 縮小してから走査する案は採らない。ブラウザの縮小補間は大きな縮小率で画素を取りこぼし、
 * 「透明でない画像を透明と誤判定 → images を捨てる」というデータ損失方向の誤りになり得るため。
 * 打ち切り側の誤り（巨大な全透明画像を通常画像として扱う）は enabled=true で画像を保持するだけで、
 * 再エクスポートのバイト列も生成される見た目も変わらない。
 */
const TRANSPARENCY_SCAN_MAX_SIZE = 1024;

/**
 * 全ピクセルの alpha が 0 か検査する。
 * デコード・検査に失敗した場合は false（通常画像として扱う安全側フォールバック）。
 */
async function isFullyTransparentImage(bytes: Uint8Array): Promise<boolean> {
  let bitmap: ImageBitmap | null = null;
  try {
    // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: 'image/png',
    });
    bitmap = await createImageBitmap(blob);
    if (
      bitmap.width > TRANSPARENCY_SCAN_MAX_SIZE ||
      bitmap.height > TRANSPARENCY_SCAN_MAX_SIZE
    ) {
      return false;
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    // OffscreenCanvas は getContext を経由せず使うと描画されない。必ず ctx 経由で描く。
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    bitmap?.close?.();
  }
}

// ===========================================================================
// sounds
// ===========================================================================

/**
 * `sounds` 配列の 1 要素からサウンド名を取り出す。MC は文字列と
 * オブジェクト形式（`{ "name": "...", "volume": ..., "weight": ... }`）の両方を受ける。
 * `type: "event"` は他のサウンドイベントへの参照でファイルを指さないため対象外（null）。
 * volume / pitch / weight 等の付帯情報は本アプリで表せないので読み捨てる。
 */
function soundItemName(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (!isRecord(item) || item.type === 'event') return null;
  return typeof item.name === 'string' ? item.name : null;
}

/**
 * サウンド名 1 つを SoundEntry に解決する。
 *
 * MC はサウンド名を `assets/<ns>/sounds/` 相対のパスと解釈し `.ogg` を自動付加するため、
 * **出力してよい正しい形式は `seedqueue:<path>`（名前空間付き・拡張子なし）だけ**。
 * 読込側は壊れたパックも拾えるよう、次の形式を受け付ける（寛容側に倒す）:
 *  - `seedqueue:custom/<event>` … 現行の出力（サブフォルダもそのままパスとして解決する）
 *  - `seedqueue:custom/silent`  … reset_all 等の「無音にする」で buildPack が割り当てる無音 ogg → off
 *  - `seedqueue:<event>` … mod 本体と同じ形式。v3.4.0 以前の custom 出力もこれ。
 *                          パック内に無く内蔵ファイル名なら mod 内蔵音（builtin）
 *  - `<event>`           … 名前空間省略。MC は `minecraft:` 扱いにするので出力しては**いけない**が、
 *                          このパック内の ogg を指す意図と解釈して読む（内蔵音とは解釈しない）
 *  - `<event>.ogg`       … v3.1.0 以前の壊れた出力で作られた既存パックとの後方互換
 * `seedqueue` 以外の名前空間を明示した名前（`minecraft:...` の音など）は表せないので null。
 *
 * 戻り値: 解決できた SoundEntry / 参照先が再生できない ogg なら `'unplayable'` / それ以外は null。
 */
function resolveSoundName(
  pack: VirtualPack,
  soundName: string,
): SoundEntry | 'unplayable' | null {
  const colon = soundName.indexOf(':');
  const namespace = colon >= 0 ? soundName.slice(0, colon) : null;
  if (namespace !== null && namespace !== SEEDQUEUE_NAMESPACE) return null;
  let path = colon >= 0 ? soundName.slice(colon + 1) : soundName;
  // 末尾の `.ogg` を剥がす（後方互換）
  if (path.toLowerCase().endsWith('.ogg')) {
    path = path.slice(0, -'.ogg'.length);
  }
  if (!path) return null;

  if (path === `${CUSTOM_SOUND_DIR}/${SILENT_SOUND_FILE}`) {
    return { mode: 'off' };
  }

  const oggBytes = readBytes(pack, `${PACK_PATHS.sounds}/${path}.ogg`);
  if (oggBytes) {
    // SeedQueue は seedqueue 名前空間の音声の読込失敗でゲームをクラッシュさせるため、
    // 再生できない ogg は取り込まない（再エクスポートで同じクラッシュを再生産しない）。
    if (!isPlayableOggVorbis(oggBytes)) return 'unplayable';
    return {
      mode: 'custom',
      ogg: { kind: 'inline', bytes: oggBytes, mimeType: 'audio/ogg' },
      originalFileName: `${path.slice(path.lastIndexOf('/') + 1)}.ogg`,
    };
  }
  // パック内に無い: mod 内蔵ファイルの参照なら builtin。名前空間省略は MC 上
  // `minecraft:` になり内蔵音を指さないので対象外。
  if (namespace !== null) {
    const builtin = BUILTIN_SOUND_KEYS.find((k) => k === path);
    if (builtin) return { mode: 'builtin', sound: builtin };
  }
  return null;
}

/**
 * sounds.json の 1 イベントを SoundEntry に解決する。null は「既定（default）のまま」。
 *
 * MC 1.16 の読込（`SoundManager`）に合わせる:
 *  - `replace: true` は下位パックと mod 既定を捨てて置き換える。`sounds` が空（省略含む）なら無音 → off。
 *  - `replace` なし／false の空は何も足さない → default。
 *  - `replace` なし／false で音がある場合、MC は既定の音に**追加**する（既定音のある
 *    lock_instance / reset_instance では既定音と抽選になる）。本アプリは混在を表せないので、
 *    参照先の音への置き換えとして読む（再エクスポートでは `replace: true` になる）。
 *  - 複数の音（ランダム再生）も表せないため、先頭から順に最初に解決できたものを採る。
 */
function parseSoundEvent(
  pack: VirtualPack,
  raw: Record<string, unknown>,
): SoundEntry | 'unresolved' | 'unplayable' | null {
  const replace = raw.replace === true;
  if (raw.sounds !== undefined && !Array.isArray(raw.sounds)) {
    return 'unresolved';
  }
  const items: unknown[] = Array.isArray(raw.sounds) ? raw.sounds : [];
  if (items.length === 0) {
    return replace ? { mode: 'off' } : null;
  }
  let sawUnplayable = false;
  for (const item of items) {
    const name = soundItemName(item);
    if (!name) continue;
    const entry = resolveSoundName(pack, name);
    if (entry === 'unplayable') {
      sawUnplayable = true;
    } else if (entry) {
      return entry;
    }
  }
  return sawUnplayable ? 'unplayable' : 'unresolved';
}

function parseSounds(
  pack: VirtualPack,
  onIssue: ParsePackOptions['onSoundIssue'],
): WallState['sounds'] {
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

  for (const key of SOUND_EVENT_KEYS) {
    const e = raw[key];
    if (!isRecord(e)) continue;
    const parsed = parseSoundEvent(pack, e);
    if (parsed === null) continue;
    if (parsed === 'unresolved' || parsed === 'unplayable') {
      // default に倒す（壊れたパック・表せない構成への対策）
      console.warn(`parsePack: ${key} のサウンドを読み込めませんでした (${parsed})`);
      onIssue?.({ event: key, kind: parsed });
      continue;
    }
    events[key] = parsed;
  }

  const allOff = SOUND_EVENT_KEYS.every((key) => events[key].mode === 'off');

  // resetUnified は全 reset 系が同じ entry に揃っていれば true、そうでなければ false。
  const resetUnified = areResetEventsUnified(events);

  return {
    globalMode: allOff ? 'off' : 'custom',
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
  const first = events[keys[0]];
  return keys.every((k) => sameSoundEntry(events[k], first));
}

/**
 * custom 同士は ogg の**バイト内容**で比較する。buildPack は各イベントを
 * `<event>.ogg` の別名で書き出すため（ファイル名は必ず食い違う）、
 * ファイル名比較では一括設定エクスポートの再インポートで unified 判定が壊れる。
 */
function sameSoundEntry(a: SoundEntry, b: SoundEntry): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'builtin' && b.mode === 'builtin') return a.sound === b.sound;
  if (a.mode !== 'custom' || b.mode !== 'custom') return true;
  if (a.ogg.kind !== 'inline' || b.ogg.kind !== 'inline') return false;
  return bytesEqual(a.ogg.bytes, b.ogg.bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
  // 編集データがあれば書き出し時の解像度がそのまま記録されている（全レイヤ非表示で
  // background.png が無いパックでも推定できる）。
  const metaResolution = readEditorMetaResolution(pack);
  if (metaResolution) return metaResolution;
  const bytes = readBytes(pack, `${PACK_PATHS.texturesGuiWall}/background.png`);
  if (!bytes) return null;
  try {
    // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: 'image/png',
    });
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
