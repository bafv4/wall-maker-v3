import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// フラット設定。Vite の React + TypeScript テンプレートに準拠。
// 型情報なし（非 type-checked）の軽量ルールに留め、CI を高速・安定に保つ。
// 厳密な型チェックは `pnpm type-check`（tsc --noEmit）が担当する。
//
// プラグインは extends ではなく明示登録する（ESLint 10 では一部プラグインの
// 旧式 config オブジェクトが flat config と非互換のため）。
export default tseslint.config(
  {
    // 生成物・依存・ネイティブ側ビルドは対象外
    ignores: ['dist', 'src-tauri', 'public/ffmpeg'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.worker, // src/workers / Web Worker クライアント用
        // Vite の define で注入されるコンパイル時定数
        __APP_VERSION__: 'readonly',
      },
    },
    rules: {
      // 定番の2ルールのみ採用。react-hooks v7 recommended の実験的ルール
      // （set-state-in-effect / preserve-caught-error 等）は誤検知が多いため不採用。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Error の `cause` 連結を要求するが、本プロジェクトは tsconfig target=ES2020 で
      // ErrorOptions が型に無い（ES2022 機能）。lib 引き上げの影響を避けるため無効化。
      'preserve-caught-error': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // `_` 始まりは「意図的に未使用」の慣習。引数・変数・catch 共に許可する。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // 設定ファイルは Node 実行
    files: ['*.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
