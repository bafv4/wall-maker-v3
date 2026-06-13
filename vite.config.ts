import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const host = process.env.TAURI_DEV_HOST;

const __dirname = dirname(fileURLToPath(import.meta.url));

// バージョン番号の単一の正は package.json の `version`。ビルド時に `__APP_VERSION__`
// として埋め込み、UI（ヘッダー / About）はここから表示する。tauri.conf.json も
// `version` を package.json 参照にしてあり、ウィンドウタイトル等と同一ソースで揃う。
const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
).version as string;

/**
 * @ffmpeg/core の UMD 配布物（`ffmpeg-core.js` / `ffmpeg-core.wasm`）を
 * `public/ffmpeg/` にコピーする。
 *
 * 背景: `@ffmpeg/core` の `package.json` の `exports` は `dist/umd/...` を直接公開しておらず、
 * Vite の `?url` 経由では UMD ファイルを取得できない。一方 ffmpeg.wasm の内部 Worker は
 * `importScripts` で UMD バンドルを読む必要があるため、ESM 版では動作しない。
 *
 * そのため、ビルド開始時／dev 起動時に node_modules から `public/` 配下にコピーし、
 * Vite のスタティック配信を通して `/ffmpeg/ffmpeg-core.js` で参照できるようにする。
 * （`public/ffmpeg/` は `.gitignore` で除外する。実体は依存からの派生で再生成可能。）
 *
 * CLAUDE.md「ffmpeg-core を CDN からランタイム取得しない（self-host する）」を満たす。
 */
function copyFFmpegCore(): PluginOption {
  const FILES = ["ffmpeg-core.js", "ffmpeg-core.wasm"];
  const copy = () => {
    const src = resolve(__dirname, "node_modules/@ffmpeg/core/dist/umd");
    const dst = resolve(__dirname, "public/ffmpeg");
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const file of FILES) {
      copyFileSync(resolve(src, file), resolve(dst, file));
    }
  };
  return {
    name: "copy-ffmpeg-core",
    buildStart() {
      copy();
    },
    configureServer() {
      copy();
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  // 配信ベースパス。GH Pages のプロジェクトサイトは `/<repo>/` 配下になるため、
  // Pages デプロイ時のみ `BASE_PATH`（例 `/wall-maker-v3/`）を環境変数で渡す。
  // Tauri / ローカル / CI（未設定）はルート `/`。`import.meta.env.BASE_URL` に反映される。
  base: process.env.BASE_PATH || '/',

  plugins: [
    react(),
    tailwindcss(),
    copyFFmpegCore(),
  ],

  // package.json の version を UI から参照できるようコンパイル時定数として埋め込む。
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
