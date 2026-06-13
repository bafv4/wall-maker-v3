/**
 * BinaryStorage — バイナリを「キー → bytes」で永続化する抽象。
 * 仕様: REWRITE_SPEC.md 第7.2章。Web=IndexedDB / Desktop=appDataDir で差し替え可能に保つ。
 */

export interface BinaryStorage {
  /** バイト列を保存。同一キーが既にあれば上書き。 */
  put(key: string, bytes: Uint8Array): Promise<void>;

  /** バイト列を読み出し。存在しなければ null。 */
  get(key: string): Promise<Uint8Array | null>;

  /** バイト列を削除。存在しなくてもエラーにしない。 */
  delete(key: string): Promise<void>;

  /** 全エントリのキー一覧。GC（state から参照されないキーの掃除）用。 */
  keys(): Promise<string[]>;
}
