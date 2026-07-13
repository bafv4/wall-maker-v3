/**
 * pngNormalize — アップロード画像バイト列の PNG 正規化。
 *
 * Minecraft はテクスチャとして PNG 以外を読めないため、JPEG/WebP/GIF 等は
 * アップロード境界でここを通して PNG に再エンコードしてから state に格納する。
 * 既に PNG のバイト列は再エンコードせずそのまま返す（無劣化・ユーザのバイト列を尊重）。
 *
 * createImageBitmap / OffscreenCanvas に依存するため**ブラウザ/Tauri webview 専用**
 * （Node では動かさない）。デコード失敗はそのまま throw する（ハンドリングは呼び出し側）。
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

export async function normalizeToPngBytes(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (isPng(bytes)) return bytes;
  const bitmap = await createImageBitmap(
    // Uint8Array<ArrayBufferLike> → BlobPart 非互換（TS 5.7+）。実 ArrayBuffer 由来なので絞り込む。
    new Blob([bytes as Uint8Array<ArrayBuffer>]),
  );
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    // getContext('2d') を経由せず convertToBlob すると InvalidStateError で reject する
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('normalizeToPngBytes: 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
