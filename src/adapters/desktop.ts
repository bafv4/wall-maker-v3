/**
 * Desktop アダプタ — Tauri 2 経由でリソースパックを読み込み／書き出しする。
 *
 * 仕様: REWRITE_SPEC.md 第10章 Phase 7-8 / CLAUDE.md「Desktop 機能を足す」。
 *
 * ファイル操作モデル（フロント仕様 — 2026-06-12 改定）:
 *  - **`.zip` エクスポート (`saveZipBytesViaDialog`)** : `.zip` 保存ダイアログ → 指定パスに 1 ファイル
 *  - **保存 (`saveAsFolder`)**                        : 親フォルダ選択 → `<parent>/<packName>/` に「名前を付けて保存」
 *  - **上書き保存 (`overwriteFolder`)**                : フォルダから開いた場合のみ。既知の root を上書き
 *  - **読込 (`DesktopPackReader.read`)**               : `desktopZip` / `desktopFolder` を受けて VirtualPack 化
 *
 * 設計:
 *  - `@tauri-apps/*` は本ファイルからのみ import する。本モジュール自体は
 *    `adapters/index.ts` から動的 import で呼ばれるため、Web バンドルには含まれない。
 *    ファイル内では静的 import で OK（既に分離済み）。
 *  - 実書き込みは Rust 側 `write_pack_folder` / `write_file` command に寄せる（fs スコープ不使用）。
 *  - Zip の生成・展開は JS 側 (JSZip) で完結させる（Rust に zip クレートを足さない）。
 *  - **バイナリは生バイトで IPC する**（下記 {@link encodeIpcContainer} 参照）。
 */

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { PackReadSource, VirtualPack } from '../core/types';
import { DEFAULT_PACK_NAME, TEXT_EXTS, zipFileToVirtualPack } from './web';

// ---------------------------------------------------------------------------
// 生バイト IPC（メタ情報 + バイナリのコンテナ）
//
// Tauri 2 の `invoke` は **引数全体が ArrayBuffer / TypedArray のときだけ**
// `application/octet-stream` の生ボディとして送る。`{ path, bytes }` のような
// オブジェクトで渡すと JSON 化され、`Uint8Array` は 10 進数値配列テキスト
// （`[137,80,78,71,...]`）になって 3〜4 倍に膨れる（20MB → 60〜70MB）。
// そのため「メタ情報 + バイト列」を 1 本のバイナリに詰めて渡す。
// 戻り方向は Rust が `tauri::ipc::Response` を返すので JS には ArrayBuffer が届く。
// フォーマットは `src-tauri/src/lib.rs` 冒頭の設計メモと対。
// ---------------------------------------------------------------------------

/**
 * `[u32 LE metaLen][meta JSON (UTF-8)][payload …]` を組み立てる。
 * `parts` は宣言順に連結される（meta 側の長さ配列と順序を必ず一致させること）。
 */
function encodeIpcContainer(
  meta: unknown,
  parts: readonly Uint8Array[],
): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  let payloadLen = 0;
  for (const part of parts) payloadLen += part.byteLength;

  const out = new Uint8Array(4 + metaBytes.byteLength + payloadLen);
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  let offset = 4 + metaBytes.byteLength;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Rust の生バイト応答を `Uint8Array` で受ける。
 *
 * 通常は custom protocol IPC 経由で `ArrayBuffer` が届く。custom protocol が使えない
 * webview では Tauri が postMessage にフォールバックし、その経路（macOS 等）では
 * 生バイトが 10 進数値配列で返るため、互換のため受けておく（低速だが動く）。
 * Rust 側 `raw_invoke_body` の引数方向フォールバックと対。
 */
function toResponseBytes(value: unknown, cmd: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error(
    `${cmd}: Rust から想定外の型が返りました（ArrayBuffer を期待）`,
  );
}

/**
 * VirtualPack を `write_pack_folder` のコンテナに詰める。
 * string 値（JSON 等）はここで UTF-8 バイト列に正規化する。
 */
function encodePackRequest(pack: VirtualPack, root: string): Uint8Array {
  const enc = new TextEncoder();
  const files: { path: string; len: number }[] = [];
  const parts: Uint8Array[] = [];
  for (const [path, value] of pack) {
    const bytes = typeof value === 'string' ? enc.encode(value) : value;
    files.push({ path, len: bytes.byteLength });
    parts.push(bytes);
  }
  return encodeIpcContainer({ root, files }, parts);
}

/**
 * `read_pack_folder` のコンテナ（meta `{ files: [{ path, len }] }` + 連結バイト列）を
 * 相対パス → バイト列の Record に戻す。
 * 各エントリは `slice` で独立バッファにする（コンテナ全体を参照し続けると、
 * 1 枚の画像を state に残しただけでフォルダ全体のバイト列が解放されない）。
 */
function decodeFolderContainer(view: Uint8Array): Record<string, Uint8Array> {
  if (view.byteLength < 4) {
    throw new Error('read_pack_folder: 応答が不正です（メタ長ヘッダなし）');
  }
  const metaLen = new DataView(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  ).getUint32(0, true);
  const metaEnd = 4 + metaLen;
  if (view.byteLength < metaEnd) {
    throw new Error('read_pack_folder: 応答が不正です（メタ部が不足）');
  }
  const meta = JSON.parse(
    new TextDecoder('utf-8').decode(view.subarray(4, metaEnd)),
  ) as { files: { path: string; len: number }[] };

  // `__proto__` という名前のファイルがあっても own プロパティとして積めるよう
  // プロトタイプなしのオブジェクトにする（通常の `{}` だと setter に吸われて消える）。
  const out = Object.create(null) as Record<string, Uint8Array>;
  let offset = metaEnd;
  for (const entry of meta.files) {
    const end = offset + entry.len;
    if (end > view.byteLength) {
      throw new Error(
        `read_pack_folder: 応答が不正です（${entry.path} のバイト列が不足）`,
      );
    }
    out[entry.path] = view.slice(offset, end);
    offset = end;
  }
  return out;
}

/**
 * Windows / macOS のファイル名禁則文字（`\ / : * ? " < > |`）を `_` に置換する。
 * Rust 側でも区切り文字を弾いているため、ここでは UX 用の正規化。
 */
function sanitizePackName(name: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|]/g, '_');
  return trimmed.length > 0 ? trimmed : DEFAULT_PACK_NAME;
}

/**
 * 親フォルダ + 子セグメントを OS のセパレータでつなぐ。
 * Tauri が返すパスのスタイル（Windows は `\`, それ以外は `/`）を検出して同じスタイルで結合する。
 */
function joinPathSegments(parent: string, child: string): string {
  const cleaned = parent.replace(/[/\\]+$/, '');
  const sep = cleaned.includes('\\') ? '\\' : '/';
  return `${cleaned}${sep}${child}`;
}

// ---------------------------------------------------------------------------
// 書き出し系
// ---------------------------------------------------------------------------

/**
 * `.zip` エクスポート — 既に zip 化済みのバイト列を保存先に書き出す。
 * Worker から流れてきた `zipBytes` をそのまま受ける（zip 化はワーカ側で完了している）。
 * キャンセル時は null。
 */
export async function saveZipBytesViaDialog(
  zipBytes: Uint8Array,
  packName: string,
): Promise<string | null> {
  const defaultName = `${sanitizePackName(packName)}.zip`;
  const path = await save({
    title: '.zip としてエクスポート',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (typeof path !== 'string') return null;

  return invoke<string>('write_file', encodeIpcContainer({ path }, [zipBytes]));
}

/**
 * 「名前を付けて保存」: 親フォルダを選ばせて `<parent>/<packName>/` を作る。
 * 既存があれば内容ごと削除して上書き。キャンセル時は null。
 */
export async function saveAsFolder(
  pack: VirtualPack,
  packName: string,
): Promise<string | null> {
  const parent = await open({
    directory: true,
    multiple: false,
    title: '保存先（親フォルダ）を選択 — 配下にリソースパック名のフォルダを作成します',
  });
  if (typeof parent !== 'string') return null;

  const root = joinPathSegments(parent, sanitizePackName(packName));
  return invoke<string>('write_pack_folder', encodePackRequest(pack, root));
}

/**
 * 「上書き保存」: 既知の root フォルダに対してパックを書き直す。
 * 既存内容は内部で削除されてから書き戻されるため、不要ファイルは消える。
 */
export async function overwriteFolder(
  pack: VirtualPack,
  root: string,
): Promise<string> {
  return invoke<string>('write_pack_folder', encodePackRequest(pack, root));
}

// ---------------------------------------------------------------------------
// 読込系
// ---------------------------------------------------------------------------

export async function readDesktopPack(
  source: PackReadSource,
): Promise<VirtualPack> {
  if (source.kind === 'desktopZip') {
    const raw = await invoke<unknown>('read_pack_zip', { path: source.path });
    return zipFileToVirtualPack(toResponseBytes(raw, 'read_pack_zip'));
  }
  if (source.kind === 'desktopFolder') {
    const raw = await invoke<unknown>('read_pack_folder', {
      path: source.path,
    });
    return folderRecordToVirtualPack(
      decodeFolderContainer(toResponseBytes(raw, 'read_pack_folder')),
    );
  }
  throw new Error(
    `readDesktopPack: 非対応の読込ソース kind=${source.kind}（Desktop は desktopZip / desktopFolder のみ対応）`,
  );
}

/**
 * フォルダ walk の結果（path → バイト列）から VirtualPack を組む。
 * テキスト拡張子（{@link TEXT_EXTS}）は UTF-8 デコード、それ以外は `Uint8Array` のまま。
 */
function folderRecordToVirtualPack(
  record: Record<string, Uint8Array>,
): VirtualPack {
  const dec = new TextDecoder('utf-8');
  const pack: VirtualPack = new Map();
  for (const [path, bytes] of Object.entries(record)) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    pack.set(path, TEXT_EXTS.has(ext) ? dec.decode(bytes) : bytes);
  }
  return pack;
}
