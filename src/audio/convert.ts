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
 *  - ライフサイクル: `load()` が解決した時点で core/wasm の blob: URL を revoke し
 *    （wasm だけで約 32MB）、最後の変換から一定時間アイドルなら `terminate()` して
 *    Worker ごと解放する。次回の変換要求で自動的に再ロードされる。
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
// 内部: 共有 FFmpeg インスタンスの遅延ロードとアイドル解放
// ---------------------------------------------------------------------------

/**
 * 最後の変換が終わってからこの時間だけ新しい変換要求が来なければ `terminate()` する。
 * ffmpeg.wasm の Worker はインスタンス化済みの wasm ヒープを抱えたままになり
 * （実測 RSS 100MB 超）、常駐する Tauri デスクトップでは特に体感に響く。
 *
 * 長さはトレードオフ。再ロードは HTTP キャッシュに当たっても `toBlobURL` の再 fetch と
 * 32MB wasm の再インスタンス化が走るので無料ではない。一方でサウンド設定は
 * 1 イベントごとにファイル選択ダイアログを開く操作なので、間隔は分単位で空く。
 * 「連続した設定作業のあいだは持ち越し、離席したら手放す」ラインとして 5 分に置く。
 */
const IDLE_TERMINATE_MS = 5 * 60_000;

let _ffmpeg: FFmpeg | null = null;
let _loadPromise: Promise<FFmpeg> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
/** キュー投入済みかつ未完了の変換数。0 のときだけアイドル解放してよい。 */
let _pending = 0;

async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  const loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    let coreURL: string | null = null;
    let wasmURL: string | null = null;
    try {
      // dist にバンドルされた core 資材を blob: URL 経由でロードする。
      // ffmpeg.wasm の内部 Worker が importScripts する際の cross-origin 回避。
      coreURL = await toBlobURL(CORE_JS_URL, 'text/javascript');
      wasmURL = await toBlobURL(CORE_WASM_URL, 'application/wasm');
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (e) {
      // `FFmpeg.load()` は失敗する前に Worker を生成している。捨てる前に必ず
      // terminate しないと、壊れた Worker が残ったまま再試行のたびに増える。
      ffmpeg.terminate();
      throw e;
    } finally {
      // load() は Worker 側で wasm のインスタンス化まで終えてから解決するので、
      // ここで blob を手放してよい。revoke しないと約 32MB の wasm Blob が
      // セッション終了まで解放されない。
      if (coreURL !== null) URL.revokeObjectURL(coreURL);
      if (wasmURL !== null) URL.revokeObjectURL(wasmURL);
    }
    _ffmpeg = ffmpeg;
    return ffmpeg;
  })();
  _loadPromise = loadPromise;

  try {
    return await loadPromise;
  } catch (e) {
    // 失敗時はリセットして次回再試行できるように。
    // アイドル解放と競合した場合に後発のロードを潰さないよう、自分の promise だけ消す。
    if (_loadPromise === loadPromise) _loadPromise = null;
    throw e;
  }
}

/** 進行中の変換があるあいだアイドル解放が走らないようにタイマを止める。 */
function cancelIdleTerminate(): void {
  if (_idleTimer !== null) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

/**
 * アイドル解放を予約する。`_pending === 0`（キューが空）のときだけ呼ぶこと。
 * `FFmpeg.terminate()` は未完了の Promise を同期的に reject するため、発火時にも
 * `_pending` を再確認して進行中の変換を巻き込まないようにする。
 */
function scheduleIdleTerminate(): void {
  cancelIdleTerminate();
  if (!_ffmpeg) return;

  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_pending > 0) return; // 予約後に変換が入っていた場合の保険
    const ffmpeg = _ffmpeg;
    // 参照を先に落として、terminate 後のインスタンスを掴ませない。
    _ffmpeg = null;
    _loadPromise = null;
    ffmpeg?.terminate();
  }, IDLE_TERMINATE_MS);
}

// ---------------------------------------------------------------------------
// 変換 API
// ---------------------------------------------------------------------------

// 共有 FFmpeg インスタンスの仮想 FS はグローバルなので、変換は必ず直列実行する。
// 並行実行を許すと exec 同士が干渉するほか、固定ファイル名では入力の上書きで
// 「別イベントの音が割り当たる」事故になる。ファイル名の連番は掃除漏れ対策の保険。
let _convertQueue: Promise<unknown> = Promise.resolve();
let _convertSeq = 0;

/**
 * 任意の audio バイナリを OGG (Vorbis) に変換する。
 * すでに OGG なら ffmpeg をロードせずそのまま返す。
 * 並行呼び出しは内部キューで直列化される（呼び出し側の抑止は不要）。
 *
 * @param input          入力バイト列
 * @param inputExtension 拡張子（小文字 / `.` なし）。ffmpeg のフォーマット推定に使う
 * @throws 変換失敗時は ffmpeg からの stderr を含むエラー
 */
export function convertToOgg(
  input: Uint8Array,
  inputExtension: string,
): Promise<Uint8Array> {
  const ext = inputExtension.toLowerCase();
  if (ext === OGG_EXT) return Promise.resolve(input);
  if (!SUPPORTED_EXTS.has(ext)) {
    return Promise.reject(new Error(`未対応のファイル形式です: .${ext}`));
  }

  // キュー投入と同時にアイドル解放を止める。キュー待ちのあいだに terminate されると
  // 実行時に Worker が消えているため、カウントは「投入〜完了」の区間で持つ。
  _pending += 1;
  cancelIdleTerminate();

  // 前段の成否に関わらず自分の変換を実行する（reject の連鎖を断つ）。
  const run = (): Promise<Uint8Array> => convertToOggExclusive(input, ext);
  const p = _convertQueue.then(run, run);
  _convertQueue = p.catch(() => undefined);

  // 最後の 1 件が片付いた時点でだけアイドル解放を予約し直す。
  const settled = (): void => {
    _pending -= 1;
    if (_pending === 0) scheduleIdleTerminate();
  };
  p.then(settled, settled);

  return p;
}

async function convertToOggExclusive(
  input: Uint8Array,
  ext: string,
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const seq = ++_convertSeq;
  const inputName = `input-${seq}.${ext}`;
  const outputName = `output-${seq}.ogg`;

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
