/**
 * Desktop 保存先メモリ — 「上書き保存」の対象フォルダをセッションを跨いで覚える。
 *
 * 仕様: CLAUDE.md「出力先はユーザに選ばせて `tauri-plugin-store` に記憶するのが基本動作」。
 *
 * 保存するのは**パス文字列 1 個だけ**（`appDataDir/<STORE_FILE>`）。CLAUDE.md の
 * 「画像/音声バイナリを tauri-plugin-store(JSON) に入れない」に従い、ここには
 * 軽い値以外を置かない。パック本体・state は一切書かない。
 *
 * 設計:
 *  - `@tauri-apps/*` の静的 import は本ファイルに閉じる。到達経路は `adapters/index.ts`
 *    からの**動的 import のみ**なので、Web バンドルには含まれない（`desktop.ts` と同じ扱い）。
 *  - 読み出し時は Rust の `path_is_dir` で**実在検証**する。前回終了後にフォルダが
 *    消えている／別ドライブが外れている場合、記憶を捨てて「無かったこと」にする
 *    （存在しない上書き先を有効に見せない）。
 *  - `tauri-plugin-store` は既定で自動保存（100ms デバウンス）だが、アプリ終了と
 *    競合しないよう書き込み系では明示 `save()` する。
 */

import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';

/** appDataDir 直下に置く store ファイル名。用途を限定するため専用ファイルにする。 */
const STORE_FILE = 'save-target.json';
/** 記憶するのはこのキー 1 個だけ（値は絶対パス文字列）。 */
const KEY = 'sourceFolder';

/** 起動時の復元結果。`missing` は「記憶はあったが実体が消えていた」。 */
export type SaveTargetRestore =
  | { kind: 'none' }
  | { kind: 'restored'; path: string }
  | { kind: 'missing'; path: string };

/**
 * Store インスタンスは 1 つだけ使い回す。
 * 失敗した Promise をキャッシュし続けないよう、reject 時はスロットを空に戻す。
 */
let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE).catch((e: unknown) => {
    storePromise = null;
    throw e;
  });
  return storePromise;
}

/**
 * store へのアクセスを直列化する 1 本の鎖。
 * 起動時の復元（読み → 実在検証 → 消失なら削除）と、ユーザ操作による書き込みが
 * 重なったとき、古い削除があとから新しい書き込みを潰さないようにする。
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  // 直前の結果（成功/失敗どちらでも）を待ってから走らせる。
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * 記憶された保存先を読み出し、実在するフォルダのときだけ採用する。
 * 実体が無ければ記憶を消して `missing` を返す（呼び出し側は無視してよい）。
 */
export function readSaveTarget(): Promise<SaveTargetRestore> {
  return enqueue<SaveTargetRestore>(async () => {
    const store = await getStore();
    const raw = await store.get<unknown>(KEY);
    // 手書き改変や旧フォーマットに備えて型を絞る。
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { kind: 'none' };
    }

    const exists = await invoke<boolean>('path_is_dir', { path: raw });
    if (!exists) {
      await store.delete(KEY);
      await store.save();
      return { kind: 'missing', path: raw };
    }
    return { kind: 'restored', path: raw };
  });
}

/** 保存先を記憶する（絶対パス 1 本のみ）。 */
export function writeSaveTarget(path: string): Promise<void> {
  return enqueue(async () => {
    const store = await getStore();
    await store.set(KEY, path);
    await store.save();
  });
}

/** 記憶を破棄する（リセット時／.zip から開き直した時）。 */
export function clearSaveTarget(): Promise<void> {
  return enqueue(async () => {
    const store = await getStore();
    await store.delete(KEY);
    await store.save();
  });
}
