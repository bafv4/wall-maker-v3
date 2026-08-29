/**
 * 表示用フォーマッタ。UI がバイト数などを人間向けに整形するときはここを通す
 * （各コンポーネントで `(n / 1024).toFixed(1)` を撒かない）。
 */

/** バイト数 → "12.3 KB" / "23.4 MB"（1 桁小数、1MB 以上は MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
