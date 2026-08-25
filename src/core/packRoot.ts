/**
 * packRoot — 読み込んだ VirtualPack の「パックルート」を正規化する純関数。
 *
 * 仕様: CLAUDE.md「VirtualPack（中間表現）」/ REWRITE_SPEC.md 第6章。
 *
 * 背景:
 *  一般に配布されている SeedQueue パックは **パックフォルダごと zip 圧縮**されていることが多く、
 *  エントリが `MyPack/pack.mcmeta` `MyPack/assets/seedqueue/wall/custom_layout.json` … になる。
 *  VirtualPack のキーはパック内パス（`assets/seedqueue/...`）である前提なので、そのまま積むと
 *  `PACK_PATHS.*` の参照が全て外れ、`parsePack` が「SeedQueue パックではない」と誤って失敗する。
 *  Desktop でユーザがパックフォルダの**親**を選んだ場合も同じことが起きる。
 *  そこで zip / フォルダどちらの読込経路でも、VirtualPack を組み立てた直後に本モジュールを通す。
 *
 * 正規化の内容（この順に実行）:
 *  1. **キーの整形** — `\` を `/` に揃え、`.` セグメントと空セグメントを畳む。
 *  2. **除外** — ディレクトリエントリ（末尾 `/` ／整形後に空になるキー）、`..` を含むキー
 *     （パストラバーサル。リソースパックに正当な用途が無いので黙って捨てる）、
 *     およびアーカイバ由来のノイズ（{@link isNoiseKey}）を落とす。
 *  3. **ルート prefix の除去** — {@link findRootPrefix} が求めた prefix を全キーから剥がす。
 *
 * 3 の挙動（明示）:
 *  - ルートに `pack.mcmeta` か `assets/` があればそこがルート。何も剥がさない。
 *    目印に `assets/seedqueue/` ではなく `assets/` を使うのは、トップレベルが `assets` だけの
 *    パックで `assets` 自身を剥がしてしまわないようにするため。
 *  - **多段ネストは繰り返し剥がす**（`Downloads/MyPack/pack.mcmeta` → `pack.mcmeta`）。
 *    ただし {@link MAX_STRIP_DEPTH} 段で打ち切る。各反復で prefix が必ず 1 セグメント伸び、
 *    対象キーは単調に減るためループは元々有限だが、想定外入力での暴走を防ぐ歯止めとして上限を置く。
 *  - **同じ階層に居るファイルは prefix 判定から除外し、剥がさずそのまま残す**。
 *    `README.txt` + `MyPack/pack.mcmeta` のような配布 zip を救うため（フォルダが 1 つに
 *    定まればそれをルートとみなす）。剥がした結果キーが衝突した場合は
 *    **パックルート配下の内容を優先**する。
 *  - 同じ階層にフォルダが複数ある場合（例: `MyPackA/` と `MyPackB/`）は曖昧なので何も剥がさない。
 *    その結果 `parsePack` が従来どおり明示エラーになる。
 *
 * 本関数は入力 Map を変更せず、常に新しい Map を返す（値の参照はそのまま共有する）。
 */

import type { VirtualPack } from './types';

/** ルート prefix を剥がす最大段数。想定外入力でのループ暴走に対する歯止め。 */
const MAX_STRIP_DEPTH = 8;

/** {@link normalizePackRoot} の結果。 */
export interface NormalizedPackRoot {
  /** ルートを引き上げ済みの VirtualPack。 */
  pack: VirtualPack;
  /**
   * 剥がしたルート prefix（POSIX 区切り・末尾スラッシュ付き。剥がしていなければ空文字）。
   * Desktop のフォルダ読込では、選択パスにこれを継ぎ足したものが実際のパックルート＝
   * 「上書き保存」の対象パスになる。親フォルダを消してしまわないために必要。
   */
  strippedPrefix: string;
}

/** ルートに居ることの目印。どちらかがあれば prefix を剥がさない。 */
function hasPackRootMarker(keys: readonly string[]): boolean {
  return keys.some((key) => key === 'pack.mcmeta' || key.startsWith('assets/'));
}

/**
 * アーカイバ / OS が勝手に混ぜるノイズエントリか。
 * これらを残すとトップレベルのフォルダが複数に見えたり、無意味なファイルが混ざるため、
 * 正規化の時点で捨ててしまう（macOS の Finder で zip 圧縮すると必ず `__MACOSX/` が入る、など）。
 */
function isNoiseKey(key: string): boolean {
  const segments = key.split('/');
  if (segments[0] === '__MACOSX') return true;
  const base = segments[segments.length - 1];
  // AppleDouble（`._foo.png`）と OS のフォルダ設定ファイル
  if (base.startsWith('._')) return true;
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini';
}

/**
 * キーを POSIX 区切りに揃え、`.` と空セグメントを畳む。
 * `..` を含む場合は正当な内容ではないので `null` を返す（呼び出し側で捨てる）。
 */
function cleanKey(key: string): string | null {
  const segments = key.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * 剥がすべきルート prefix を求める（末尾スラッシュ付き。不要なら空文字）。
 * 挙動の詳細はモジュール冒頭の JSDoc を参照。
 */
function findRootPrefix(keys: readonly string[]): string {
  let prefix = '';
  for (let depth = 0; depth < MAX_STRIP_DEPTH; depth += 1) {
    // 現在の prefix 配下だけを見る（上の階層に取り残したファイルは判定に含めない）
    const scoped = keys
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    if (scoped.length === 0) break;
    if (hasPackRootMarker(scoped)) break;
    // この階層のフォルダ名を集める。直下のファイルは prefix 判定から除外する。
    const dirs = new Set<string>();
    for (const key of scoped) {
      const slash = key.indexOf('/');
      if (slash > 0) dirs.add(key.slice(0, slash));
    }
    if (dirs.size !== 1) break;
    prefix += `${[...dirs][0]}/`;
  }
  return prefix;
}

/**
 * VirtualPack のキーを整形し、ネストされたパックルートを引き上げる。
 * 詳細な挙動はモジュール冒頭の JSDoc を参照。
 */
export function normalizePackRoot(pack: VirtualPack): NormalizedPackRoot {
  // 1) + 2) キー整形とノイズ除去
  const entries: [string, Uint8Array | string][] = [];
  for (const [rawKey, value] of pack) {
    // ディレクトリエントリ（`MyPack/` 等）はパックの内容ではない
    if (rawKey.endsWith('/') || rawKey.endsWith('\\')) continue;
    const key = cleanKey(rawKey);
    if (key === null || isNoiseKey(key)) continue;
    entries.push([key, value]);
  }

  // 3) ルート prefix の除去。衝突時はパックルート配下（= prefix を剥がした側）を優先するため、
  //    先に配下を積んでから、取り残されたファイルを空きキーにだけ入れる。
  const strippedPrefix = findRootPrefix(entries.map(([key]) => key));
  const out: VirtualPack = new Map();
  for (const [key, value] of entries) {
    if (key.startsWith(strippedPrefix)) {
      out.set(key.slice(strippedPrefix.length), value);
    }
  }
  for (const [key, value] of entries) {
    if (!key.startsWith(strippedPrefix) && !out.has(key)) {
      out.set(key, value);
    }
  }
  return { pack: out, strippedPrefix };
}
