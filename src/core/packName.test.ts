/**
 * packName のセキュリティ不変条件を固定するテスト。
 *
 * 守る性質: **サニタイズ後の文字列は、常にパス区切りも相対セグメントも含まない
 * 「1 個のフォルダ名」である**。Desktop の「名前を付けて保存」はこの文字列を
 * ユーザが選んだ親フォルダに連結し、Rust 側がその root を再帰削除してから書き直す。
 * ここが緩むと、選んでいないディレクトリ（`.minecraft` 全体など）が消える。
 *
 * パック名は自由入力なだけでなく、**インポートしたパックのファイル名から自動で入る**
 * （useFileOperations）ため、攻撃者が名前を決められる前提でテストする。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACK_NAME, sanitizePackName } from './packName';

describe('sanitizePackName — パス脱出の遮断', () => {
  it.each(['.', '..', '...', '....'])(
    'ドットのみの名前 %j は既定名に落とす（連結すると親へ脱出するため）',
    (name) => {
      expect(sanitizePackName(name)).toBe(DEFAULT_PACK_NAME);
    },
  );

  it('インポートしたファイル名由来の stem（`...zip` → `..`）を弾く', () => {
    // useFileOperations は displayName から `.zip` を落として stem にする。
    const stem = '...zip'.replace(/\.zip$/i, '').trim();
    expect(stem).toBe('..');
    expect(sanitizePackName(stem)).toBe(DEFAULT_PACK_NAME);
  });

  it.each([
    ['a/b', 'a_b'],
    ['a\\b', 'a_b'],
    ['../evil', '.._evil'],
    ['..\\..\\evil', '.._.._evil'],
    ['C:/Windows', 'C__Windows'],
  ])('区切り文字を含む %j は 1 セグメント %j になる', (input, expected) => {
    expect(sanitizePackName(input)).toBe(expected);
  });

  it('どんな入力でも区切り文字を残さない', () => {
    const hostile = [
      '../..',
      '..%2f..',
      'a\u0000b',
      '\\\\server\\share',
      './.',
      '..../....',
    ];
    for (const name of hostile) {
      const out = sanitizePackName(name);
      expect(out).not.toMatch(/[/\\]/);
      expect(out.split('.').every((seg) => seg !== '..')).toBe(true);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe('sanitizePackName — ファイル名としての正規化', () => {
  it('禁則文字を `_` に置換する', () => {
    expect(sanitizePackName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('制御文字を `_` に置換する', () => {
    expect(sanitizePackName('a\u0001b\u007fc')).toBe('a_b_c');
  });

  it('末尾のドットと空白を落とす（Windows が黙って落とすため）', () => {
    expect(sanitizePackName('pack.')).toBe('pack');
    expect(sanitizePackName('pack ')).toBe('pack');
    expect(sanitizePackName('pack. . ')).toBe('pack');
  });

  it.each(['CON', 'con', 'NUL', 'com1', 'LPT9', 'nul.txt'])(
    'Windows 予約デバイス名 %j は既定名に落とす',
    (name) => {
      expect(sanitizePackName(name)).toBe(DEFAULT_PACK_NAME);
    },
  );

  it('空・空白のみは既定名に落とす', () => {
    expect(sanitizePackName('')).toBe(DEFAULT_PACK_NAME);
    expect(sanitizePackName('   ')).toBe(DEFAULT_PACK_NAME);
  });
});

describe('sanitizePackName — 正常な名前は壊さない', () => {
  it.each([
    'seedqueue-pack',
    'My Pack',
    'my.pack.v2',
    '日本語のパック名',
    'pack_2026',
    '..zip', // 区切りも相対セグメントも無いので通常のフォルダ名として有効
  ])('%j はそのまま通す', (name) => {
    expect(sanitizePackName(name)).toBe(name);
  });

  it('冪等である（二重適用で変化しない）', () => {
    for (const name of ['..', 'a/b', 'pack.', 'CON', '正常', 'x'.repeat(200)]) {
      const once = sanitizePackName(name);
      expect(sanitizePackName(once)).toBe(once);
    }
  });
});
