/**
 * 音声変換ユーティリティ — MP3/WAV/AAC 等を SeedQueue 用 OGG (Vorbis) に変換する。
 *
 * 仕様: REWRITE_SPEC.md 第9章 / CLAUDE.md「ffmpeg-core を CDN からランタイム取得しない（self-host する）」。
 *
 * 設計:
 *  - `ffmpeg.wasm` v0.12（`@ffmpeg/ffmpeg` + `@ffmpeg/core`）を使用する。
 *  - **ランタイム CDN 取得は禁止**。`@ffmpeg/core` の UMD 配布物（`ffmpeg-core.js` /
 *    `ffmpeg-core.wasm`）は Vite プラグイン `copyFFmpegCore`（`vite.config.ts`）が
 *    `public/ffmpeg/` にコピーし、`/ffmpeg/...` で静的配信される。`toBlobURL` で
 *    blob: URL に変換して内部 Worker の `importScripts` cross-origin 制約を回避する。
 *  - 注: `@ffmpeg/core` の `package.json` `exports` は UMD パスを公開していないため、
 *    `?url` での deep import はできない。コピー方式が必要。
 *  - 最初の `convertToOgg` で初期化（lazy）。1 度ロードした FFmpeg インスタンスを使い回し、
 *    並行呼び出しはロード Promise を共有する。
 *
 * ライセンス: FFmpeg / @ffmpeg/core は GPL v2 以降、@ffmpeg/ffmpeg・@ffmpeg/util は MIT。
 * 詳細は AboutModal と README を参照。
 *
 * 入力ファイル: `audio/*`（拡張子から ffmpeg のフォーマット推定）。
 * OGG ファイルは ffmpeg をロードせず素通しする。
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

/**
 * Vite プラグイン `copyFFmpegCore` がコピーする静的配信パス。
 * `import.meta.env.BASE_URL`（= Vite の base、末尾 `/`）を前置して、GH Pages の
 * サブパス配信（例 `/wall-maker-v3/`）でも 404 にならないようにする。
 * Tauri / ルート配信では BASE_URL=`/` なので従来どおり。
 */
const CORE_JS_URL = `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.js`;
const CORE_WASM_URL = `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.wasm`;

const OGG_EXT = 'ogg';

/** UI 受け付け対象。それ以外は拒否（ffmpeg がエラーを返すため事前に弾く）。 */
const SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  'ogg',
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'opus',
  'webm',
]);

/** ファイル名（または拡張子のみ）から対応可否を判定。 */
export function isSupportedAudioExt(filenameOrExt: string): boolean {
  const ext = (filenameOrExt.split('.').pop() ?? '').toLowerCase();
  return SUPPORTED_EXTS.has(ext);
}

// ---------------------------------------------------------------------------
// 内部: 共有 FFmpeg インスタンスの遅延ロード
// ---------------------------------------------------------------------------

let _ffmpeg: FFmpeg | null = null;
let _loadPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    // dist にバンドルされた core 資材を blob: URL 経由でロードする。
    // ffmpeg.wasm の内部 Worker が importScripts する際の cross-origin 回避。
    await ffmpeg.load({
      coreURL: await toBlobURL(CORE_JS_URL, 'text/javascript'),
      wasmURL: await toBlobURL(CORE_WASM_URL, 'application/wasm'),
    });
    _ffmpeg = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await _loadPromise;
  } catch (e) {
    _loadPromise = null; // 失敗時はリセットして次回再試行できるように
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 変換 API
// ---------------------------------------------------------------------------

/**
 * 任意の audio バイナリを OGG (Vorbis) に変換する。
 * すでに OGG なら ffmpeg をロードせずそのまま返す。
 *
 * @param input          入力バイト列
 * @param inputExtension 拡張子（小文字 / `.` なし）。ffmpeg のフォーマット推定に使う
 * @throws 変換失敗時は ffmpeg からの stderr を含むエラー
 */
export async function convertToOgg(
  input: Uint8Array,
  inputExtension: string,
): Promise<Uint8Array> {
  const ext = inputExtension.toLowerCase();
  if (ext === OGG_EXT) return input;
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`未対応のファイル形式です: .${ext}`);
  }

  const ffmpeg = await getFFmpeg();
  const inputName = `input.${ext}`;
  const outputName = 'output.ogg';

  try {
    await ffmpeg.writeFile(inputName, input);
    // -c:a libvorbis: Ogg Vorbis エンコーダ
    // -q:a 6: 品質 6 (約 192kbps 相当・Minecraft の効果音には十分)
    const code = await ffmpeg.exec([
      '-i',
      inputName,
      '-c:a',
      'libvorbis',
      '-q:a',
      '6',
      outputName,
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg が非ゼロ終了コードを返しました: ${code}`);
    }
    const out = await ffmpeg.readFile(outputName);
    if (typeof out === 'string') {
      throw new Error('ffmpeg が文字列を返しました（バイナリ期待）');
    }
    return new Uint8Array(out);
  } finally {
    // 中間ファイルの掃除（失敗してもエラーは握り潰す）
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}
