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
 */

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { PackReadSource, VirtualPack } from '../core/types';
import { DEFAULT_PACK_NAME, TEXT_EXTS, zipFileToVirtualPack } from './web';

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * VirtualPack の string 値（JSON 等）を UTF-8 バイト列に正規化する。
 * Tauri IPC は `Vec<u8>` を期待するため、Uint8Array に揃える。
 */
function packToBytes(pack: VirtualPack): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const out: Record<string, Uint8Array> = {};
  for (const [path, value] of pack) {
    out[path] = typeof value === 'string' ? enc.encode(value) : value;
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

/**
 * Rust から戻ってきた `Vec<u8>` を `Uint8Array` に正規化する。
 * Tauri 2 + serde の既定では JSON 数値配列でシリアライズされるため、`Array.isArray` 経由で受ける。
 */
function toUint8Array(value: unknown): Uint8Array {
  if (!Array.isArray(value)) {
    throw new Error('Rust から想定外の型が返りました（数値配列を期待）');
  }
  return Uint8Array.from(value as number[]);
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

  return invoke<string>('write_file', { path, bytes: zipBytes });
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
    title: '保存先（親フォルダ）を選択 — 配下に pack 名のフォルダを作成します',
  });
  if (typeof parent !== 'string') return null;

  const root = joinPathSegments(parent, sanitizePackName(packName));
  return invoke<string>('write_pack_folder', {
    root,
    files: packToBytes(pack),
  });
}

/**
 * 「上書き保存」: 既知の root フォルダに対してパックを書き直す。
 * 既存内容は内部で削除されてから書き戻されるため、不要ファイルは消える。
 */
export async function overwriteFolder(
  pack: VirtualPack,
  root: string,
): Promise<string> {
  return invoke<string>('write_pack_folder', {
    root,
    files: packToBytes(pack),
  });
}

// ---------------------------------------------------------------------------
// 読込系
// ---------------------------------------------------------------------------

export async function readDesktopPack(
  source: PackReadSource,
): Promise<VirtualPack> {
  if (source.kind === 'desktopZip') {
    const raw = await invoke<unknown>('read_pack_zip', { path: source.path });
    return zipFileToVirtualPack(toUint8Array(raw));
  }
  if (source.kind === 'desktopFolder') {
    const raw = await invoke<Record<string, unknown>>('read_pack_folder', {
      path: source.path,
    });
    return folderRecordToVirtualPack(raw);
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
  record: Record<string, unknown>,
): VirtualPack {
  const dec = new TextDecoder('utf-8');
  const pack: VirtualPack = new Map();
  for (const [path, raw] of Object.entries(record)) {
    const bytes = toUint8Array(raw);
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    pack.set(path, TEXT_EXTS.has(ext) ? dec.decode(bytes) : bytes);
  }
  return pack;
}
