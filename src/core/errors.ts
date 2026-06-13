/**
 * core/errors.ts — エラー関連の小さな共有ヘルパー。
 */

/** `unknown` を toast / console 用の表示文字列に丸める。Error なら message を、それ以外は String() を返す。 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
