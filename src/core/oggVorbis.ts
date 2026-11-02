/**
 * Ogg Vorbis の識別ヘッダ検査。
 *
 * SeedQueue は `seedqueue` 名前空間の音声の読込に失敗するとゲームを意図的にクラッシュさせる
 * （`SoundSystemMixin#crashBrokenSeedQueueSoundFiles`）。Minecraft 1.16 のデコーダ
 * （stb_vorbis + OpenAL）が扱えるのは **Vorbis・1〜2 チャンネル**だけなので、拡張子が `.ogg`
 * でも Opus（`OpusHead`）や 3ch 以上、空・壊れたファイルはそのまま同梱してはいけない。
 *
 * 判定は 1 ページ目の先頭パケット（Vorbis 識別ヘッダ）だけを見る軽量なもの。
 * デコードまではしないので「ヘッダは正しいが中身が壊れている」ファイルは検出できない。
 */

/** Vorbis 識別ヘッダの先頭 7 バイト（packet type 0x01 + "vorbis"）。 */
const VORBIS_ID_SIGNATURE = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73] as const;

/**
 * Ogg Vorbis ならチャンネル数を返す。Ogg でない / Vorbis でない（Opus 等）/ 短すぎるなら null。
 *
 * レイアウト: Ogg ページヘッダは 27 バイト固定部の末尾（offset 26）がセグメント数 n、
 * 続く n バイトがセグメントテーブル、その直後から最初のパケットが始まる。
 * Vorbis 識別ヘッダは signature(7) + vorbis_version(4) + audio_channels(1) …。
 */
export function inspectOggVorbis(bytes: Uint8Array): { channels: number } | null {
  if (bytes.length < 27) return null;
  // "OggS"
  if (
    bytes[0] !== 0x4f ||
    bytes[1] !== 0x67 ||
    bytes[2] !== 0x67 ||
    bytes[3] !== 0x53
  ) {
    return null;
  }
  const packetStart = 27 + (bytes[26] ?? 0);
  const channelsOffset = packetStart + VORBIS_ID_SIGNATURE.length + 4;
  if (bytes.length <= channelsOffset) return null;
  for (let i = 0; i < VORBIS_ID_SIGNATURE.length; i++) {
    if (bytes[packetStart + i] !== VORBIS_ID_SIGNATURE[i]) return null;
  }
  return { channels: bytes[channelsOffset] ?? 0 };
}

/** Minecraft 1.16 がそのまま再生できる Ogg Vorbis（1〜2ch）か。 */
export function isPlayableOggVorbis(bytes: Uint8Array): boolean {
  const info = inspectOggVorbis(bytes);
  return info !== null && info.channels >= 1 && info.channels <= 2;
}
