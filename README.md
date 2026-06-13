# SeedQueue Wall Maker

Minecraft Speedrunning 用 [SeedQueue](https://github.com/contariaa/seedqueue) mod
のリソースパックを GUI で作成・編集するツール。同一コードベースで **Web 版**
（ブラウザ）と **Desktop 版**（Tauri 2）を提供します。

設計の指針は **「事実（フォーマットの定数・形）はコピー、構造（アーキテクチャ）は再構築」**。
詳細は [`REWRITE_SPEC.md`](./REWRITE_SPEC.md) / [`CLAUDE.md`](./CLAUDE.md) を参照。

## 主な機能

- レイアウト編集：プレビュー上で main / locked / preparing エリアをドラッグ・リサイズ
  （境界は `Math.floor` で整数 px 化、SeedQueue が割合と誤解釈する小数を出さない）
- 背景：色 / 画像 / グラデーションのレイヤ合成（Canvas でリアルタイム合成）
- Lock 画像：複数枚を順序保持で出力（1 枚目は `lock.png`、以降 `lock-N.png`）
- サウンド：全 13 イベントを網羅。MP3/WAV/AAC/M4A/FLAC/OPUS/WEBM → OGG を
  self-host した ffmpeg.wasm で変換
- パック I/O：
  - **Web** — `.zip` でインポート、`.zip` ダウンロードでエクスポート
  - **Desktop** — `.zip` / フォルダ から読み込み、`.zip` エクスポート ＋
    フォルダ形式での「名前を付けて保存」「上書き保存」

## 開発

```bash
pnpm install          # 依存インストール
pnpm dev              # Web 開発サーバ (Vite)
pnpm build            # Web 本番ビルド
pnpm tauri dev        # デスクトップ開発（Tauri + Vite）
pnpm tauri build      # デスクトップ配布ビルド
```

## リリースビルド（Windows / macOS）

リリースは GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）で
自動化しています。配布対象は **Win + Mac**、自動更新なし、署名は最小限です。

### 自動ビルド（推奨）

```bash
git tag v3.0.0-dev  # 例: -dev / -beta / -rc 付きは Pre-release 扱い
git push origin v3.0.0-dev
```

- `windows-latest` と `macos-latest` のマトリックスで並列ビルドし、
  GitHub Releases にドラフトとして添付されます
- macOS は **Universal Binary**（Intel + Apple Silicon）で出力
- Windows は `.msi` (WiX) と `.exe` (NSIS) の両方を出力（Tauri 既定）

「Actions」タブから `release` ワークフローを `workflow_dispatch` で手動実行することもできます。
その場合は Release を作らず、各 OS のバンドルが **Workflow Artifacts** に保存されます。

### ローカルビルド

```bash
pnpm tauri build                                      # 現在のプラットフォーム向け
pnpm tauri build --target universal-apple-darwin      # macOS ユニバーサル（Mac 上のみ）
```

成果物は `src-tauri/target/release/bundle/` 配下に出力されます。

### 署名・配布時の注意

| OS | 署名 | 起動時の挙動 |
|---|---|---|
| **macOS** | Ad-hoc（`tauri.conf.json > bundle.macOS.signingIdentity = "-"`） | 初回起動時「開発元を検証できない」警告。Finder で右クリック→「開く」→確認ダイアログで「開く」 |
| **Windows** | 未署名 | SmartScreen 警告。「詳細情報」→「実行」で起動 |

Apple Developer 証明書を持っていないため macOS の正規署名・公証（notarization）は行いません。
配布物は ad-hoc 署名のみで、Gatekeeper の警告は **許容** する方針です（CLAUDE.md 第10章 Phase 9 参照）。

Mac ビルドは macOS 実機（ローカル or GitHub Actions の macOS runner）でのみ可能です。

## サードパーティライセンス

### FFmpeg / @ffmpeg/core (GPL v2 以降)

本アプリは MP3/WAV/AAC/M4A/FLAC/OPUS/WEBM を Ogg Vorbis に変換するために
**FFmpeg** を **ffmpeg.wasm** 経由で利用しています。

- FFmpeg: <https://github.com/FFmpeg/FFmpeg>
- 同梱している `ffmpeg-core.wasm` は ffmpeg.wasm 既定の core ビルドで、
  **GPL v2 以降** でライセンスされています
  （[GPL v2 全文](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)）
- ffmpeg-core は外部 CDN を使わず、ローカルに同梱（**self-host**）しています。
  `vite.config.ts` の `copyFFmpegCore` プラグインが
  `node_modules/@ffmpeg/core/dist/umd/` → `public/ffmpeg/` にコピーします
- GPL の要請に応えるため、`ffmpeg-core.js` / `ffmpeg-core.wasm` はアプリ本体と
  独立したアセットとして出力されます。ユーザは自身でビルドした
  ffmpeg-core 資材を `public/ffmpeg/` に置いて差し替えできます

### ffmpeg.wasm JS ラッパー (MIT)

- `@ffmpeg/ffmpeg` / `@ffmpeg/util`: <https://github.com/ffmpegwasm/ffmpeg.wasm>
- MIT License

### その他

- React 19 (MIT) / Zustand 5 (MIT) / JSZip (MIT or GPLv3) / Tailwind CSS v4 (MIT) /
  react-colorful (MIT) / Tauri 2 (MIT / Apache-2.0)
- SeedQueue mod (Minecraft) — <https://github.com/contariaa/seedqueue>

アプリ内の **About** ダイアログ（ヘッダタイトルをクリック、または Desktop の
「ファイル」タブ）からも同じ情報を確認できます。

## ライセンス（このプロジェクト本体）

Copyright (C) 2026 bafv4 and contributors.

本プロジェクトは **GNU General Public License v3 以降（GPL-3.0-or-later）** で
ライセンスされています。同梱の `ffmpeg-core.wasm`（GPL v2 以降）と互換にするため
GPL を採用しています。

> This program is free software: you can redistribute it and/or modify
> it under the terms of the GNU General Public License as published by
> the Free Software Foundation, either version 3 of the License, or
> (at your option) any later version.
>
> This program is distributed in the hope that it will be useful,
> but WITHOUT ANY WARRANTY; without even the implied warranty of
> MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
> GNU General Public License for more details.

ライセンス全文は [`LICENSE`](./LICENSE) を参照してください。
（<https://www.gnu.org/licenses/gpl-3.0.html>）
