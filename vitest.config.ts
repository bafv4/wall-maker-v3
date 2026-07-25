/**
 * Vitest 設定。
 *
 * `vite.config.ts` を継承しない（別ファイルを置くと Vitest はこちらを使う）。
 * 本体の Vite 設定は React/Tailwind プラグインと ffmpeg-core のコピーを buildStart で
 * 走らせるが、テスト対象は core の純ロジックだけなのでどれも不要。
 *
 * 方針（CLAUDE.md「Verification」）:
 *  - パック出力のフィクスチャ比較テストは**行わない**。現行出力は ground truth にできない。
 *  - ここで守るのは**入力バリデーションの不変条件**だけ。手動の実機検証を置き換えるものではなく、
 *    「境界のクランプ／サニタイズが将来の編集で黙って外れないこと」を固定する。
 *  - よって environment は node。DOM/Canvas に依存するコード（renderBackground, 音声変換,
 *    store の永続化）はここでは扱わない。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
