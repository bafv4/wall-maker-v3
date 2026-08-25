/**
 * WallState — SeedQueue Wall Maker のドメイン状態。`buildPack` / `parsePack` が入出力する唯一の正規 state。
 * 仕様: REWRITE_SPEC.md 第6章（SeedQueue ソース由来＝絶対的な正） / 第7.1章。
 */

// 初期レイアウトは layoutPresets の「Default」を共有する（値 import）。
// layoutPresets 側は state から型のみ import（type-only・実行時依存なし）なので循環しない。
import { getDefaultPresetLayout } from './layoutPresets';

// ---------------------------------------------------------------------------
// バイナリ参照（永続化境界を型で明示）
// インメモリでは bytes を持ち、永続化レイヤを跨ぐと storageKey 参照に置換される。
// Web=IndexedDB / Desktop=appDataDir のファイル実体を指す（第7.2章）。
// ---------------------------------------------------------------------------

export type BinaryRef =
  | { kind: 'inline'; bytes: Uint8Array; mimeType?: string }
  | { kind: 'ref'; storageKey: string; mimeType?: string };

// ---------------------------------------------------------------------------
// 解像度
// ---------------------------------------------------------------------------

export interface Resolution {
  width: number;
  height: number;
}

/** 既定の framebuffer 解像度。初期 state と数値ガードのフォールバックで共有する。 */
export const DEFAULT_RESOLUTION: Resolution = { width: 1920, height: 1080 };

// ---------------------------------------------------------------------------
// エリア / グループ（main / locked / preparing が共通で使う形）
//
// x/y/width/height は **絶対 px の整数**。境界で必ず Math.floor で整数化する
// （第4.5章 / 第6.3.1章）。小数を持たせると SeedQueue が framebuffer 比率と
// 誤解釈してレイアウトが破壊される。
//
// rows/columns は **1 以上の整数**。0・負・小数は UI/state で弾く（第6.3章）。
// ---------------------------------------------------------------------------

export interface AreaCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Area {
  /** 絶対 px・整数。境界で Math.floor 適用済みであること。 */
  x: number;
  y: number;
  width: number;
  height: number;

  /** 1 以上の整数。0・負・小数は不可。 */
  rows: number;
  columns: number;

  /**
   * アプリ内部フラグ。true=rows/columns でグリッド、false=positions を使う。
   * エクスポート時に strip（第6.3.2章）。
   */
  useGrid?: boolean;

  /** useGrid=false のときに使う明示セル座標。エクスポートでは positions として出力。 */
  positions?: AreaCell[];

  /** インスタンス間の間隔 px。0 は省略可（第6.3.2章）。 */
  padding?: number;

  // ---- 機能拡充候補（第6.3章・全 Group 共通の任意キー） ----
  /** Group の表示専用フラグ。main では不可（仕様上の制約）。 */
  cosmetic?: boolean;
  /** このグループでインスタンス背景を描画するか（既定 true）。 */
  instance_background?: boolean;
  /** このグループでインスタンスオーバーレイを描画するか（既定 true）。 */
  instance_overlay?: boolean;
}

/** main エリア。`mainFillOrder` は main のみ持つ（第6.3章）。 */
export interface MainArea extends Area {
  /** main の埋め順。既定 FORWARD（第6.3章）。 */
  mainFillOrder?: 'FORWARD' | 'BACKWARD' | 'RANDOM';
}

/** locked / preparing 用。エディタで表示 ON/OFF を持つ（show は内部フラグ→strip）。 */
export interface VisibleArea extends Area {
  show: boolean;
}

// ---------------------------------------------------------------------------
// 背景レイヤ（color / image / gradient の判別共用体）
// 旧 store の構造を踏襲（第7.1章）。判別子は `type`。
// ---------------------------------------------------------------------------

export type BackgroundLayer = ColorLayer | ImageLayer | GradientLayer;

export interface ColorLayer {
  id: string;
  type: 'color';
  color: string;
  opacity: number;
  visible: boolean;
}

export interface ImageLayer {
  id: string;
  type: 'image';
  /** インメモリは inline、永続化越しは ref になり得る。 */
  source: BinaryRef;
  opacity: number;
  visible: boolean;
  /**
   * 画像の配置モード。
   *  - stretch: 解像度に伸縮
   *  - cover:   余白なしで切り抜き
   *  - contain: 全部見える余白あり
   *  - manual:  `transform` 矩形で自由配置（ユーザがプレビューで move/resize）
   */
  fit: 'stretch' | 'cover' | 'contain' | 'manual';
  /** fit='manual' のときの宛先矩形（絶対 px・整数）。未設定なら stretch 同等。 */
  transform?: { x: number; y: number; width: number; height: number };
  /** 画像内のクロップ矩形（fit に応じて使用）。省略時は全体。 */
  crop?: { x: number; y: number; width: number; height: number };
  /** UI 表示用の元ファイル名（任意）。 */
  originalFileName?: string;
}

export interface GradientLayer {
  id: string;
  type: 'gradient';
  /** stops は offset 0..1。最低 2 個。 */
  stops: GradientStop[];
  /** 角度（度数法）。0=下→上（CSS linear-gradient と同じ）、90=左→右。実装側で正規化する。 */
  angle: number;
  opacity: number;
  visible: boolean;
}

export interface GradientStop {
  offset: number;
  color: string;
}

// ---------------------------------------------------------------------------
// サウンド（全 13 イベント・第6.6章）
// ---------------------------------------------------------------------------

/**
 * SeedQueue のサウンドイベント全 13 種（`SeedQueueSounds.java` 由来）。
 * `as const` 配列から union 型を抽出し、ループ網羅性チェックに使える形にしておく。
 */
export const SOUND_EVENT_KEYS = [
  'play_instance',
  'lock_instance',
  'reset_instance',
  'reset_all',
  'reset_column',
  'reset_row',
  'schedule_join',
  'schedule_all',
  'scheduled_join_warning',
  'start_benchmark',
  'finish_benchmark',
  'open_wall',
  'bypass_wall',
] as const;

export type SoundEventKey = (typeof SOUND_EVENT_KEYS)[number];

/**
 * 各イベントの設定。
 * - default: 何も出力しない（MOD 既定にフォールバック）
 * - off:     `{ replace: true, sounds: [] }` を出力（無音）
 * - custom:  ogg バイト＋`{ replace: true, sounds: ["seedqueue:<event>"] }`
 *            （MC がサウンド名に .ogg を自動付加するため拡張子は書かない。第6.6章）
 */
export type SoundEntry =
  | { mode: 'default' }
  | { mode: 'off' }
  | {
      mode: 'custom';
      /** 変換済み ogg バイト参照。変換はアップロード時に済ませる（第7.3章）。 */
      ogg: BinaryRef;
      /** UI 表示用の元ファイル名（保存しなくてもよい）。 */
      originalFileName?: string;
    };

/**
 * グローバル設定（旧アプリ踏襲）。
 * - off:     全イベントを一括 off 出力
 * - custom:  per-event 設定を反映
 * resetUnified=true のとき、reset_instance / reset_all / reset_column / reset_row を
 * UI 上で 1 設定としてまとめる（state には個別に保持する／同期更新するかは UI 層で決める）。
 */
export interface SoundSettings {
  globalMode: 'off' | 'custom';
  resetUnified: boolean;
  events: Record<SoundEventKey, SoundEntry>;
}

// ---------------------------------------------------------------------------
// lock 画像（第6.5章）
// 出力順は **1 枚目=`lock.png`、2 枚目以降=`lock-1.png`, `lock-2.png`, ...**。
// アップロード画像はリサイズしない。enabled=false なら透明 128x128 の `lock.png` を出力。
// ---------------------------------------------------------------------------

export interface LockImage {
  id: string;
  source: BinaryRef;
  /** UI 表示用の元ファイル名（任意）。 */
  originalFileName?: string;
  /**
   * `<lock>.png.mcmeta` の `seedqueue.weight`（抽選の重み、第6.5章）。
   * 未指定なら {@link LockImages.defaultWeight} が使われる。SeedQueue は
   * `Math.max(1, weight)` を取るので実効値は必ず 1 以上になる。
   */
  weight?: number;
  /**
   * 取り込んだ `.mcmeta` のうち `seedqueue` **以外**のセクション（`animation` など）。
   * 本アプリはアニメーションを編集できないが、書き出し時にそのまま戻すことで
   * インポート → エクスポートで他パックのメタデータを落とさないようにする。
   */
  mcmetaExtra?: Record<string, unknown>;
}

export interface LockImages {
  enabled: boolean;
  images: LockImage[];
  /**
   * `lock.png.mcmeta` の `seedqueue.defaultWeight`。個別の `weight` を持たない画像に
   * 適用される既定の重みで、SeedQueue は **`lock.png` のメタデータからのみ**読む
   * （読めなければ 1）。
   *
   * 物理的には lock.png に載るが、意味はコレクション全体の既定値なのでここに置く。
   * `LockImage` 側に持たせると並べ替えで 1 枚目が変わったときに値が別画像へ移り、
   * パック全体の抽選確率が黙って変わってしまう。
   */
  defaultWeight?: number;
}

// ---------------------------------------------------------------------------
// パック情報
// ---------------------------------------------------------------------------

export interface PackInfo {
  name: string;
  description: string;
  /** pack.png 用アイコン。null=出力しない。 */
  icon: BinaryRef | null;
}

// ---------------------------------------------------------------------------
// 機能拡充候補のテクスチャスロット（第6.4章）
// overlay / instance_background / instance_overlay は任意・アニメ可。
// 今は型で受けるだけ。UI 未実装でも optional で保持。
// ---------------------------------------------------------------------------

export interface ExtraTextures {
  overlay?: BinaryRef;
  instance_background?: BinaryRef;
  instance_overlay?: BinaryRef;
}

// ---------------------------------------------------------------------------
// WallState（唯一の正規 state）
// ---------------------------------------------------------------------------

export interface WallState {
  resolution: Resolution;
  layout: {
    main: MainArea;
    locked: VisibleArea;
    /** SeedQueue 仕様準拠で配列（複数 preparing グループ可）。空配列=出力なし。 */
    preparing: VisibleArea[];
  };
  background: { layers: BackgroundLayer[] };
  extraTextures: ExtraTextures;
  packInfo: PackInfo;
  sounds: SoundSettings;
  lockImages: LockImages;
  replaceLockedInstances: boolean;
}

// ---------------------------------------------------------------------------
// バリデーション（不変条件の検証。正規化は core/coords.ts の toSafeInt 系が担当）
// 不変条件: rows/columns は 1 以上の整数 / 座標は整数 / 負サイズ禁止。
// エリアの重なりは許容（検証しない・第7.3章）。
//
// ここは「壊れているかを判定する述語」であって値を直さない。値を直す側（floorArea 等）は
// coords.ts に集約してあるが、state.ts → coords.ts の import は循環になるため参照しない。
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

/** rows/columns が 1 以上の整数か。 */
export function isValidGridCount(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

/** 座標・サイズが有限の整数で、サイズが 1 以上か（x/y は負を許容）。 */
export function isValidAreaGeometry(area: AreaCell): boolean {
  return (
    Number.isInteger(area.x) &&
    Number.isInteger(area.y) &&
    Number.isInteger(area.width) &&
    Number.isInteger(area.height) &&
    area.width >= 1 &&
    area.height >= 1
  );
}

function validateArea(area: Area, path: string, out: ValidationIssue[]): void {
  if (!isValidAreaGeometry(area)) {
    out.push({
      path,
      message: 'x/y/width/height must be integers and width/height >= 1',
    });
  }
  if (!isValidGridCount(area.rows)) {
    out.push({ path: `${path}.rows`, message: 'rows must be an integer >= 1' });
  }
  if (!isValidGridCount(area.columns)) {
    out.push({
      path: `${path}.columns`,
      message: 'columns must be an integer >= 1',
    });
  }
  if (
    area.padding !== undefined &&
    (!Number.isInteger(area.padding) || area.padding < 0)
  ) {
    out.push({
      path: `${path}.padding`,
      message: 'padding must be an integer >= 0',
    });
  }
  area.positions?.forEach((cell, i) => {
    if (!isValidAreaGeometry(cell)) {
      out.push({
        path: `${path}.positions[${i}]`,
        message: 'x/y/width/height must be integers and width/height >= 1',
      });
    }
  });
}

/** WallState 全体の不変条件を検証する。問題がなければ空配列。 */
export function validateWallState(state: WallState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (
    !Number.isInteger(state.resolution.width) ||
    state.resolution.width < 1 ||
    !Number.isInteger(state.resolution.height) ||
    state.resolution.height < 1
  ) {
    issues.push({
      path: 'resolution',
      message: 'width/height must be integers >= 1',
    });
  }

  validateArea(state.layout.main, 'layout.main', issues);
  validateArea(state.layout.locked, 'layout.locked', issues);
  state.layout.preparing.forEach((p, i) =>
    validateArea(p, `layout.preparing[${i}]`, issues),
  );

  state.background.layers.forEach((layer, i) => {
    if (layer.type === 'image' && layer.transform) {
      if (!isValidAreaGeometry(layer.transform)) {
        issues.push({
          path: `background.layers[${i}].transform`,
          message: 'x/y/width/height must be integers and width/height >= 1',
        });
      }
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// デフォルト state ファクトリ
// 1920x1080 想定の最小構成（main 2x3 グリッド、locked/preparing は非表示）。
// テスト UI / 初回起動 / リセットに使う。
// ---------------------------------------------------------------------------

export function createDefaultSoundSettings(): SoundSettings {
  const events = {} as Record<SoundEventKey, SoundEntry>;
  for (const key of SOUND_EVENT_KEYS) {
    events[key] = { mode: 'default' };
  }
  return {
    globalMode: 'custom',
    resetUnified: true,
    events,
  };
}

export function createDefaultWallState(): WallState {
  const resolution: Resolution = { ...DEFAULT_RESOLUTION };
  return {
    resolution,
    // 初期レイアウトは「Default」プリセット（定義は layoutPresets.ts に集約）。
    layout: getDefaultPresetLayout(resolution),
    background: {
      layers: [
        {
          id: 'default-bg',
          type: 'color',
          color: '#000000',
          opacity: 1,
          visible: true,
        },
      ],
    },
    extraTextures: {},
    packInfo: {
      name: 'SeedQueue Resource Pack',
      description: 'Generated by SeedQueue Wall Maker',
      icon: null,
    },
    sounds: createDefaultSoundSettings(),
    lockImages: {
      enabled: false,
      images: [],
    },
    replaceLockedInstances: false,
  };
}
