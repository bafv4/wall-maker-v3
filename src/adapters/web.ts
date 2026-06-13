/**
 * Web アダプタ — JSZip を使った export (ZIP ダウンロード) と import (ZIP File→VirtualPack)。
 *
 * 仕様: REWRITE_SPEC.md 第10章 Phase 6 / CLAUDE.md「2層分離」。
 *
 * 設計:
 *  - core 層には I/O を持ち込まない。`buildPack`/`parsePack` で確定した VirtualPack を
 *    本アダプタが ZIP に詰める／展開するだけ。
 *  - ZIP 化はメモリ上で blob を作り、`<a download>` トリックでブラウザにダウンロードさせる。
 *  - 大容量パックでも UI が固まらないよう、JSZip の処理は Web Worker に逃がす方が望ましい
 *    （Phase 9 のパフォーマンス対応候補）。現状はメインスレッドで処理。
 */

import JSZip from 'jszip';
import type { PackReadSource, VirtualPack } from '../core/types';

/**
 * ZIP / フォルダどちらの読込でも「テキストとして decode する」拡張子の単一ソース。
 * desktop.ts の `folderRecordToVirtualPack` もこの Set を import して使う。
 * それ以外の拡張子は `Uint8Array` のまま VirtualPack に積む。
 */
export const TEXT_EXTS: ReadonlySet<string> = new Set(['json', 'mcmeta', 'txt']);

/** 空名フォールバック。Web のダウンロード名 / Desktop の保存先パック名の既定値の単一ソース。 */
export const DEFAULT_PACK_NAME = 'seedqueue-pack';

/** ファイル名の正規化。空白だけ／空のときは {@link DEFAULT_PACK_NAME} にフォールバック。 */
export function normalizePackName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PACK_NAME;
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/**
 * VirtualPack → .zip バイト列。Worker からも呼ばれる。
 * `pack` 内の string 値は JSZip がそのまま UTF-8 エンコードしてくれる。
 */
export async function packToZipBytes(pack: VirtualPack): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, value] of pack) {
    zip.file(path, value);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * 完成済みの zip バイト列をブラウザにダウンロードさせる。
 * Web Worker から戻ってきたバイト列をそのまま渡せる。Web はキャンセル不可なので常に
 * ダウンロードファイル名を返す。
 */
export function saveZipBytesAsDownload(
  zipBytes: Uint8Array,
  packName: string,
): string {
  const filename = `${normalizePackName(packName)}.zip`;
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // 一部ブラウザは DOM に挿入されたリンクでないと click() が無視されるため、念のため append/remove
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}

// ---------------------------------------------------------------------------
// 読込
// ---------------------------------------------------------------------------

export async function readWebPack(
  source: PackReadSource,
): Promise<VirtualPack> {
  if (source.kind !== 'webZip') {
    throw new Error(
      `readWebPack: 非対応の読込ソース kind=${source.kind}（Web は webZip のみ対応）`,
    );
  }
  return zipFileToVirtualPack(source.file);
}

/**
 * .zip バイナリ (File / Blob / ArrayBuffer / Uint8Array いずれか) → VirtualPack。
 * 拡張子で text / binary を振り分け、ディレクトリエントリは無視する。
 * 失敗は呼び出し側でキャッチ可能なエラーとして throw（メッセージは JSZip 由来をそのまま）。
 *
 * Desktop アダプタも Rust 側 `read_pack_zip` の結果（Uint8Array）を本関数に流す。
 */
export async function zipFileToVirtualPack(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<VirtualPack> {
  const zip = await JSZip.loadAsync(input);
  const pack: VirtualPack = new Map();
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir) continue;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (TEXT_EXTS.has(ext)) {
      pack.set(path, await entry.async('string'));
    } else {
      pack.set(path, await entry.async('uint8array'));
    }
  }
  return pack;
}
