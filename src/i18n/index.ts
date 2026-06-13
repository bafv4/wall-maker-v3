/**
 * i18n エントリ — i18next + react-i18next 初期化。
 *
 * - 言語: 日本語 (`ja`) / 英語 (`en`)。fallback は `ja`。
 * - 初期表示言語は **OS の表示言語** に合わせる:
 *   - Web      : `navigator.language`（ブラウザ＝OS 言語）を languagedetector が同期検出。
 *   - Desktop  : webview の `navigator` が OS と一致しないことがあるため、起動時に
 *                Tauri OS プラグインの `locale()` を取得して適用する（`initOsLanguage`）。
 * - ユーザが UI で明示選択した言語は `EXPLICIT_LANG_KEY` に記録し、以降は OS 自動適用
 *   より優先する（`setLanguage` 経由で切り替えること）。検出値自体は `i18nextLng` に
 *   キャッシュされ、次回起動の同期初期値になる。
 * - `main.tsx` から副作用 import で同期初期化 → `initOsLanguage()` を await する。
 *
 * 翻訳キーは hierarchical ドット記法。型補完はあえて入れず、未定義キーは表示時に
 * キー文字列がそのまま出るので開発中に拾いやすい運用。
 */

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { isTauri } from '../adapters';
import en from './locales/en.json';
import ja from './locales/ja.json';

export const SUPPORTED_LANGUAGES = ['ja', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** ユーザが UI で明示的に選んだ言語を記録するキー（OS 自動適用より優先）。 */
const EXPLICIT_LANG_KEY = 'wm.langExplicit';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ja: { translation: ja },
      en: { translation: en },
    },
    fallbackLng: 'ja',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    nonExplicitSupportedLngs: true, // `en-US` → `en` などを許容
    interpolation: {
      escapeValue: false, // React が XSS 対策するので i18next 側の escape は不要
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
  });

/**
 * UI からの明示的な言語切り替え。`EXPLICIT_LANG_KEY` を立ててから言語を変える。
 * 以降は `initOsLanguage()` の OS 自動適用より、この選択が優先される。
 */
export function setLanguage(lng: SupportedLanguage): Promise<unknown> {
  try {
    localStorage.setItem(EXPLICIT_LANG_KEY, lng);
  } catch {
    // localStorage 不可（プライベートモード等）でも言語切替自体は続行する。
  }
  return i18n.changeLanguage(lng);
}

/**
 * デスクトップ（Tauri）でのみ、OS 表示言語を初期表示言語として適用する。
 * Web は languagedetector の `navigator` 検出で十分なので何もしない。
 * ユーザが明示選択済み（`EXPLICIT_LANG_KEY` あり）の場合はその選択を尊重して何もしない。
 * `'en-US'` 等の地域付きロケールは `supportedLngs` + `nonExplicitSupportedLngs` で `en` に解決される。
 */
export async function initOsLanguage(): Promise<void> {
  if (!isTauri()) return;
  try {
    if (localStorage.getItem(EXPLICIT_LANG_KEY)) return;
  } catch {
    // localStorage を読めない環境では OS 適用を試みる（実害なし）。
  }
  try {
    const { locale } = await import('@tauri-apps/plugin-os');
    const osLocale = await locale(); // 例: 'en-US' / 'ja-JP' / null
    if (osLocale) await i18n.changeLanguage(osLocale);
  } catch {
    // 取得失敗時は同期検出の結果（navigator/fallback）のままにする。
  }
}

export default i18n;
