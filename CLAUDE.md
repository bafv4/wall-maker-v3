# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current Task

`REWRITE_SPEC.md` 第11章を参照。まず `src/core/` に `WallState` / `SoundSettings`（13イベント）/ `BackgroundLayer`
の型定義一式と、`buildPack(state): Promise<VirtualPack>` / `coords`（変換・スケール・`Math.floor` 整数化）の
シグネチャ草案＋最小スタブを起こす。実装本体ではなく型とシグネチャが成果物。第6章（SeedQueue ソース由来＝正）と必ず整合させる。

## Project Overview

SeedQueue Wall Maker は、Minecraft Speedrunning の [SeedQueue](https://github.com/contariaa/seedqueue) mod 用
リソースパックを GUI で作成するツール。旧 `mcsr-tools` モノレポから切り出して再構築した単一アプリで、
**同一コードベースから Web 版とデスクトップ版（Tauri）を提供する**。

- **Web/デスクトップの唯一の差分**：リソースパックを直接ファイル操作できるか。
  - Web: ZIP を生成してダウンロード。
  - Desktop: `.minecraft/resourcepacks/` へフォルダ/ZIP を直接書き出し（＋既存パックの読込編集）。

設計の指針は **「事実（フォーマットの定数・形）はコピー、構造（アーキテクチャ）は再構築」**。
旧コードは参照実装であって、フォークして育てる対象ではない。

## Development Commands

```bash
pnpm install          # 依存インストール
pnpm dev              # Web 開発サーバ (Vite)
pnpm build            # Web 本番ビルド
pnpm lint             # ESLint
pnpm type-check       # tsc --noEmit

pnpm tauri dev        # デスクトップ開発（Tauri + Vite）
pnpm tauri build      # デスクトップ配布ビルド
```

## Architecture

### 2層分離（最重要）

出力/入力ロジックを **core（純粋）** と **adapter（環境依存）** に分ける。差分は adapter にだけ閉じる。

- **`src/core/`** — プラットフォーム非依存（ただし Canvas を使うため**ブラウザ/Tauri webview 専用**。Node では動かさない）。React/Tauri には依存しない。
  - `buildPack(state: WallState): VirtualPack` — state からパックを構成する純関数（音声変換は含まない、後述）。
  - `parsePack(pack: VirtualPack): WallState` — パックから state を復元する純関数。
  - Canvas 背景描画（color/image/gradient 合成）、型定義、フォーマット定数。
  - `coords.ts` — 座標変換（プレビューpx↔実解像度px）とスケール。**境界で `Math.floor` 整数化**（小数を出力しない）。
- **`src/adapters/`** — `VirtualPack` を各環境に流し込む/取り出す薄い層。
  - `web.ts` — JSZip で zip 化しダウンロード / `<input type=file>` で読込。
  - `desktop.ts` — Tauri 経由。**必ず動的 import で読み込む**（後述）。

### VirtualPack（中間表現）

`type VirtualPack = Map<string, Uint8Array | string>`。
キーはパック内パス（例 `"assets/seedqueue/wall/custom_layout.json"`）、値は JSON 文字列かバイナリ。
`buildPack` はここまでで I/O を持たず確定させる。書き出し先（zip/フォルダ）は adapter の責務。

### プラットフォーム判定とアダプタ選択

```ts
export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function getPackWriter(): Promise<PackWriter> {
  if (isTauri()) {
    const { DesktopPackWriter } = await import('./desktop'); // 動的 import 必須
    return new DesktopPackWriter();
  }
  const { WebPackWriter } = await import('./web');
  return new WebPackWriter();
}
```

> **`@tauri-apps/*` を静的 import しないこと。** Web バンドルがモジュール解決に失敗する。
> デスクトップアダプタは常に動的 import で隔離する。

### State / Store

- `WallState` が唯一の正規 state。`buildPack` / `parsePack` は同じ `WallState` を入出力する。
- 背景は `background.layers: BackgroundLayer[]`（color/image/gradient の判別共用体）に統一。
  **旧コードのようにフラットな `type`/`image`/`imageLayers` を作らない。**
- Zustand 5。UI 状態とドメイン state を分離。
- **永続化は2層**：軽い state（レイアウト・設定値）は `persist`(localStorage) / Desktop は `tauri-plugin-store`。
  画像/音声バイナリは store/JSON に載せず逃がす：**Web=IndexedDB、Desktop=appDataDir の実ファイル**。
  state に永続化するのは**参照（キー/相対パス）のみ**で、ロード時に復元する（インメモリ state はバイナリを保持）。
  base64 を全部 `persist` すると上限超過するため。IndexedDB は非同期なので非同期 StateStorage アダプタを使う。
- 座標・スケールは `core/coords.ts` に集約（store から直接計算しない）。`setResolution` はエリアと背景レイヤ両方をスケール。

## Resource Pack Format（崩してはいけない事実 / SeedQueue ソース由来＝絶対的な正）

詳細・出所は `REWRITE_SPEC.md` 第6章（SeedQueue 本体ソースで確定。**これを正とする**）。要点:

- `pack.mcmeta`: `{ pack: { pack_format: 5, description } }`。SeedQueue は 1.15.2/1.16.1 用のみで**両方 format 5**、定数 5 で固定。
- 構成: `wall/custom_layout.json`、`textures/gui/wall/` 配下に `background.png` `overlay.png`
  `instance_background.png` `instance_overlay.png` `lock.png`（いずれも任意・アニメ可）、`sounds.json`、`sounds/<event>.ogg`。
- **数値の意味（最重要・旧バグの正体）**: `custom_layout.json` の `x/y/width/height` は
  **小数点付き＝framebuffer に対する割合、整数＝絶対px**。本アプリは絶対px なので**必ず整数で出す**（`Math.floor`）。
  小数を出すと割合と解釈されレイアウトが壊れる。
- **エクスポート時の strip / 正規化**:
  - `useGrid`/`show` はアプリ内部フラグ。削除（SeedQueue 仕様外）。`locked`/`preparing` は表示時のみ出力。
  - `padding` 0 は省略可。`replaceLockedInstances`(bool) をトップレベルに付与。`rows`/`columns` は **1以上の整数必須**。
  - 任意キー: `mainFillOrder`(FORWARD/BACKWARD/RANDOM)、Group の `cosmetic`/`instance_background`/`instance_overlay`、`preparing` 配列。
- **lock 画像**: 読み込み順は **`lock.png`（必ず1枚目）→ `lock-1.png` → `lock-2.png` …**。
  `lock.png` が無いと SeedQueue は以降を一切読まない。複数時も**1枚目は `lock.png`、2枚目以降が `lock-1.png`〜**。
  サイズ自由（アスペクト比保持）。無効化は透明 `lock.png`（プレースホルダ、アプリは 128x128）。アップロード画像はリサイズしない。
- **sounds.json**: イベントは**全13種**（`play_instance` `lock_instance` `reset_instance` `reset_all` `reset_column`
  `reset_row` `schedule_join` `schedule_all` `scheduled_join_warning` `start_benchmark` `finish_benchmark` `open_wall` `bypass_wall`）。
  既定音は `lock_instance`/`reset_instance` のみ。default=書かない / off=`{replace:true,sounds:[]}` /
  custom=`{replace:true,sounds:["<event>.ogg"]}`＋ogg配置。変更するイベントのみ出力すればよい。

> フォーマットを変更したら、代表パターンを出力して **Minecraft 実機で読み込み検証**する（自動比較テストは行わない）。
> 現行アプリの出力は不具合があり ground truth に使えないため、フィクスチャ比較はしない。
> SeedQueue のフォーマットはズレても目視で気づきにくく、ゲーム内で黙って効かないパックになる。

## Common Tasks

**新しい設定項目を足す**:
1. `WallState`（`src/core/state.ts`）に型を追加。
2. store と該当エディタコンポーネントを更新。
3. `buildPack` に出力ロジックを追加（内部フラグの strip を忘れない）。
4. `parsePack` に復元ロジックを追加。
5. 代表パターンを1つ出力し、Minecraft で読み込み検証する（第2.3章）。

**出力先を増やす/変える**:
- `core` には触れず、`src/adapters/` に `PackWriter`/`PackReader` 実装を足すだけ。

**デスクトップ機能を足す**:
- フロントは動的 import 経由でのみ Tauri API を呼ぶ。
- 大容量バイナリ書き込みは Rust 側 `write_pack` command に寄せる（fs プラグインのフロント API スコープを避けられる）。
- 出力先は**ユーザに選ばせて `tauri-plugin-store` に記憶する**のが基本動作。`.minecraft` の自動検出はしない
  （MCSR は MultiMC/Prism のインスタンス別フォルダが多い）。初回ダイアログの既定パスはホームディレクトリ。
- 権限は `src-tauri/capabilities/` で最小化（`requireLiteralLeadingDot: false` で `.minecraft` を扱う）。
- 配布対象は Win+Mac、自動更新なし、署名最小限（未署名警告は許容）。

## Verification

- 自動比較テストは行わない。**代表パターンを出力し Minecraft 実機で読み込んで検証する**のが唯一の手段。
- 現行アプリの出力は不具合があり ground truth に使えない。フィクスチャ比較はしない。
- 検証パターンと手順は `REWRITE_SPEC.md` 第2.3章を参照。
- `parsePack` は、生成したパックを再インポートしてエディタ状態が復元されることを実機操作で確認する。

## Quality / Validation

- **入力バリデーション**（手動検証の最後の砦）：`rows`/`columns` は 1以上の整数のみ許可（0/負/小数を state/UI で弾く）。
  座標は `Math.floor` 整数化、負サイズ禁止。**エリアの重なりは許容**（SeedQueue 動作上問題なし、検証しない）。
- **音声**：ogg 変換はアップロード時に行い、変換済みバイトを `WallState` に格納。`buildPack` は変換しない。
- **パフォーマンス**：Web は `buildPack`/zip を Web Worker に逃がし進捗表示。Desktop は Rust の `write_pack` で吸収。
- **エラー UX**：`alert()` を使わずトースト等の非ブロッキング表示に統一。

## Do Not

- 旧モノレポの `@mcsr-tools/types`、`MinecraftItemIcon`、`packages/mcitems`、Minecraft アイテム/エンチャント系を持ち込まない（wall-maker は未使用）。
- `core` から React / Tauri 以外の環境 API に依存しない（`buildPack` は Canvas 依存で webview 専用、Node では実行しない）。
- `custom_layout.json` に小数座標を出さない（SeedQueue が割合と誤解釈する）。`rows`/`columns` に 0/小数を出さない。
- lock 複数画像で `lock.png` を省略しない（1枚目は必ず `lock.png`、以降 `lock-1.png`〜）。
- ffmpeg-core を CDN からランタイム取得しない（self-host する）。FFmpeg ライセンス表記は README とアプリ内 About に必須。
- 画像/音声バイナリを `tauri-plugin-store`(JSON) や localStorage に直接入れない（Web=IndexedDB、Desktop=appDataDir ファイルへ逃がす）。
- 旧共有 URL 形式（`?layout=<base64>`）の互換は実装しない（サポート対象外）。
- `.minecraft` パスの自動検出を実装しない（ユーザ選択＋記憶が基本）。
