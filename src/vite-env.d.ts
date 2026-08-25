/// <reference types="vite/client" />

/**
 * package.json の `version`（素の semver。`v` 接頭辞は含まない）。
 * `vite.config.ts` の `define` で注入されるコンパイル時定数。
 * UI で `v3.1.0` のように見せたい場合は表示側で `v` を付ける。
 */
declare const __APP_VERSION__: string;
