/**
 * core/types.ts — プラットフォーム非依存の中間表現とアダプタ・インターフェース。
 * 仕様: REWRITE_SPEC.md 第4.2章 / 第4.3章。
 */

/**
 * リソースパックを書き出し先に依存しない形で表現する中間表現。
 * キーはパック内パス（例: "assets/seedqueue/wall/custom_layout.json"）。
 * 値は JSON 文字列か任意バイナリ。
 *
 * 例:
 *   "pack.mcmeta"                                        -> string (JSON)
 *   "pack.png"                                           -> Uint8Array
 *   "assets/seedqueue/wall/custom_layout.json"           -> string (JSON)
 *   "assets/seedqueue/textures/gui/wall/background.png"  -> Uint8Array
 *   "assets/seedqueue/textures/gui/wall/lock.png"        -> Uint8Array
 *   "assets/seedqueue/sounds.json"                       -> string (JSON)
 *   "assets/seedqueue/sounds/lock_instance.ogg"          -> Uint8Array
 */
export type VirtualPack = Map<string, Uint8Array | string>;

/**
 * パック読込ソース。プラットフォーム間の入力差を吸収する判別共用体。
 *  - `webZip`        : Web の `<input type=file>` で得た File（.zip）
 *  - `desktopZip`    : Desktop で選択された .zip パス
 *  - `desktopFolder` : Desktop で選択されたフォルダパス
 *
 * 書き出しは `Uint8Array` (zip) または `VirtualPack` (folder) を直接受け取る関数
 * （`adapters/index.ts` の `saveZipBytes` / `adapters/desktop.ts` の `saveAsFolder`
 * `overwriteFolder`）で吸収する。Writer/Reader インターフェースは持たない。
 */
export type PackReadSource =
  | { kind: 'webZip'; file: File }
  | { kind: 'desktopZip'; path: string }
  | { kind: 'desktopFolder'; path: string };

// ---------------------------------------------------------------------------
// SeedQueue リソースパックのフォーマット定数（第6章）
// 値を直接 import して使う。マジックナンバーを各所に書かないこと。
// ---------------------------------------------------------------------------

/**
 * pack.mcmeta の `pack_format`。
 * SeedQueue は 1.15.2 / 1.16.1 用のみ公開され、**両方とも format 5** で固定。
 */
export const PACK_FORMAT = 5 as const;

/** リソース識別子の名前空間。 */
export const SEEDQUEUE_NAMESPACE = 'seedqueue' as const;

/** パック内パス（リテラル）。`buildPack` / `parsePack` で共有する。 */
export const PACK_PATHS = {
  packMcmeta: 'pack.mcmeta',
  packPng: 'pack.png',
  customLayout: 'assets/seedqueue/wall/custom_layout.json',
  soundsJson: 'assets/seedqueue/sounds.json',
  texturesGuiWall: 'assets/seedqueue/textures/gui/wall',
  sounds: 'assets/seedqueue/sounds',
} as const;

/** lock 画像の無効化プレースホルダのサイズ（透明 PNG, 第6.5章）。 */
export const PLACEHOLDER_LOCK_SIZE = 128 as const;
