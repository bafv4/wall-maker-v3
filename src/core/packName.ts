/**
 * packName — パック名を「ファイルシステム上の 1 セグメント」として安全化する単一ソース。
 *
 * パック名は完全に信用できない入力である:
 *  - UI のテキスト入力（自由入力）
 *  - **インポートしたパックのファイル名**（`useFileOperations` が stem を state に入れる）
 *
 * この文字列は Desktop の「名前を付けて保存」で親フォルダに連結され、Rust 側
 * `write_pack_folder` が **その root を再帰削除してから書き直す**。したがって
 * `..` / `.` のような相対セグメントを通すと、ユーザが選んでいないディレクトリ
 * （例: `.minecraft` 全体）が消える。区切り文字だけでなく **ドットのみの名前と
 * Windows の予約デバイス名も弾く**のが本モジュールの役目。
 *
 * 防御は多層で、ここが破れても Rust 側 `resolve_pack_root` が `.`/`..` を拒否する。
 */

/** 空名・不正名フォールバック。Web のダウンロード名 / Desktop の保存先フォルダ名の既定値。 */
export const DEFAULT_PACK_NAME = 'seedqueue-pack';

/** Windows の予約デバイス名（拡張子を付けても予約されたまま）。 */
const RESERVED_WINDOWS_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** ファイル名禁則文字（Windows/macOS）。制御文字は {@link stripControlChars} で別途潰す。 */
const FORBIDDEN_CHARS = /["*/:<>?\\|]/g;

/**
 * 制御文字（U+0000–U+001F, U+007F）を `_` に潰す。
 * 正規表現リテラルに制御文字を直書きしないよう、コードポイント判定で行う。
 */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? '_' : ch;
  }
  return out;
}

/**
 * パック名をファイル名 1 セグメントとして安全化する。
 *
 * 手順:
 *  1. 前後の空白を除去
 *  2. 禁則文字と制御文字を `_` に置換
 *  3. 末尾のドット・空白を除去（Windows はこれらを黙って落とすため）
 *  4. ドットのみの名前（`.` `..` `...`）は相対セグメントになるので拒否
 *  5. 予約デバイス名（`CON` `NUL` `COM1` …）は拒否
 *  6. 残りが空なら {@link DEFAULT_PACK_NAME}
 */
export function sanitizePackName(name: string): string {
  const replaced = stripControlChars(name.trim().replace(FORBIDDEN_CHARS, '_'));
  const trimmed = replaced.replace(/[. ]+$/, '');
  if (trimmed.length === 0) return DEFAULT_PACK_NAME;
  // `.` `..` `...` などドットのみ。パス連結時に親ディレクトリへ脱出する。
  if (/^\.+$/.test(trimmed)) return DEFAULT_PACK_NAME;
  const stem = trimmed.split('.')[0]?.toLowerCase() ?? '';
  if (RESERVED_WINDOWS_NAMES.has(stem)) return DEFAULT_PACK_NAME;
  return trimmed;
}
