# SeedQueue Wall Maker — Re-write 仕様書 (v1.4)

## 0. この文書について

旧 `mcsr-tools` モノレポ内の `seedqueue-pack-creator`（通称 wall-maker, 内部 v2.4.0 / 表示 v2.5.0）を、
**機能拡充・品質向上・Web + デスクトップ両対応**を目的に新リポジトリへ再構築するための仕様書。

基本方針は **「事実（フォーマットの定数・形）はコピー、構造（アーキテクチャ）は再構築」**。
旧コードはフォークして育てる対象ではなく、正しい仕様を読み取るための参照実装として扱う。

---

## 1. 目的とゴール

- 単一アプリとして独立した新リポジトリを立て、wall-maker 関連資産のみを引き込む。
- 出力パイプラインを純粋ロジックとプラットフォームアダプタの2層に分離する。
- Tauri 2 を導入し、Web 版とデスクトップ版を同一コードベースから提供する。
  - **Web/デスクトップの唯一の差分は「リソースパックのファイルを直接操作できるか」**。
  - Web: ZIP 生成 → ダウンロード（従来挙動）。
  - Desktop: `.minecraft/resourcepacks/` へフォルダ/ZIP を直接書き出し（＋将来は既存パックの読込編集）。
- 旧コードに残る既知のバグ・デッドコード・データモデル不整合を一掃する。

### 非ゴール（今回やらないこと）

- 旧モノレポの他アプリ（`minipractice-nbt-editor`, `mcsr-config-tool`）の移植。
- `packages/mcitems`（13MB）・Minecraft アイテム/エンチャント系ユーティリティの持ち込み。

---

## 2. 移行方針（最重要）

### 2.1 写す部分（正しく動いており、再導出が危険なもの）

そのまま、もしくはほぼそのまま移植する。

- **リソースパックのフォーマット知識**（→ 第6章に確定仕様として記録）。
- **Canvas 背景描画ロジック**：`drawColorLayer` / `drawGradientLayer` / `drawImageLayer` とアスペクト比計算。
  現状で正しく動作しているため、作り直して新バグを入れない。`core/` 内の純関数として移植する。
- **i18n 翻訳** (`translations.ts`)、**プリセット** (`presets.ts`)。
- **UI プリミティブ**：`Button` / `Input` / `Select` / `Switch` / `Tabs` / `Modal` / `VersionChip` / `cn`。

### 2.2 作り直す部分（バグ・負債が乗っており構造の妨げになるもの）

- store のデータモデル（背景レイヤモデルの統一、永続化）。
- import/export パイプライン → `buildPack` / `parsePack` + アダプタへ再設計。
- `App.tsx` の繋ぎ込み。

### 2.3 検証方針（現行アプリを正としない）

当初は「旧アプリの出力をゴールデンフィクスチャとして採取し、新 `buildPack` の出力と構造比較する」方法を
想定していたが、**現行アプリ自体に不具合が確認されているため、その出力を正解（ground truth）として扱えない**。
したがってこの方法は採らない。

代わりに、**新アプリから代表的なパターンをいくつか出力し、実際に Minecraft に読み込ませて実機検証する**ことを
唯一の検証手段とする（自動比較テストは行わない）。SeedQueue のフォーマットは微妙なズレが
「ゲーム内で黙って効かないパック」を生むため、最終的な正しさは実機での読み込みでしか担保できない。

検証すべき代表パターン（最低限）:

1. 最小構成（main のみ、グリッド有効、背景は単色、サウンド default）。
2. locked + preparing 両方表示、padding あり、useGrid 一部無効。
3. 背景レイヤ複数（color + image + gradient の重ね）。
4. lock 画像 1枚 / 複数枚 / 無効（透明 PNG）の3バリエーション。
5. サウンド globalMode = `off` / `custom`（reset unified と separate 両方）。
6. 解像度 1920x1080 / 2560x1440 / カスタム。

各パターンについて、Minecraft でリソースパックを有効化し、SeedQueue の Wall 画面で
レイアウト・背景・ロック表示・サウンドが意図通りかを確認する。`parsePack`（読込）は、生成したパックを
新アプリに再インポートしてエディタ状態が正しく復元されることを実機操作で確認する。

---

## 3. 抽出マニフェスト

旧 `apps/seedqueue-pack-creator/` から引き込む対象を確定する。

| 区分 | 旧パス | 新リポジトリでの扱い |
|------|--------|----------------------|
| アプリ本体 | `src/App.tsx` `src/main.tsx` `src/index.css` | 構造再設計の上で移植 |
| コンポーネント | `src/components/*` | プレビュー/各エディタを移植（後述の store 変更に追従） |
| store | `src/store/useWallStore.ts` | データモデルを再設計して移植 |
| 出力/入力 | `src/utils/packExport.ts` `packImport.ts` | `core/buildPack` `core/parsePack` として書き直し |
| 音声変換 | `src/utils/audioConverter.ts` | 移植（ffmpeg-core を自前ホスト化、第9章参照） |
| データ | `src/data/presets.ts` | そのまま移植 |
| i18n | `src/i18n/*` | そのまま移植 |
| UI | `packages/ui/src/{Button,Input,Select,Switch,Tabs,Modal,VersionChip}.tsx` `lib/utils.ts` | `src/components/ui/` に同梱 |
| ユーティリティ | `packages/utils` の `downloadFile` 相当 | Web アダプタ内に数行で再実装 |
| 設定 | `tailwind.config.js` `postcss.config.js` | Tailwind v4 化に合わせて更新 |
| 静的資産 | `public/icon.png` | そのまま移植 |
| ドキュメント | `DARK_MODE_GUIDE.md` `IMPORT_FORMAT.md` | テーマ/仕様の参照として移植 |

**引き込まないもの**：`@mcsr-tools/types` 一式（wall-maker は未使用）、`MinecraftItemIcon`、
`packages/mcitems`、`packages/utils` の Minecraft アイテム/エンチャント系、他2アプリ、`turbo.json` 等のモノレポ構成。

`api/index.ts`（Vercel serverless での OGP 動的差し替え）は Web デプロイ方針確定後に移植可否を判断（第9章）。

---

## 4. アーキテクチャ

### 4.1 2層分離

```
state (WallState)
   │
   ▼
[ core ] buildPack(state) ──► VirtualPack  (Map<string, Uint8Array | string>)
   │                                │
   │                                ├─► [ adapter: web ]     JSZip → download(.zip)
   │                                └─► [ adapter: desktop ] Tauri fs / write_pack command → フォルダ or .zip
   ▲
[ core ] parsePack(VirtualPack) ◄── アダプタが読み込んだファイル群
```

- **core 層**：プラットフォーム非依存の純粋ロジック。`buildPack` / `parsePack` / Canvas 描画 / 型定義。
  React にも Tauri にも依存しない。**ユニットテストの対象**。
- **adapter 層**：`VirtualPack` を各環境に流し込む/各環境から取り出す薄い層。差分はここだけに閉じる。

### 4.2 VirtualPack（中間表現）

パックを構成するファイル群を、書き出し先に依存しない形で表現する。

```ts
// core/types.ts
export type VirtualPack = Map<string, Uint8Array | string>;
// 例:
//   "pack.mcmeta"                                        -> string (JSON)
//   "pack.png"                                           -> Uint8Array
//   "assets/seedqueue/wall/custom_layout.json"           -> string (JSON)
//   "assets/seedqueue/textures/gui/wall/background.png"  -> Uint8Array
//   "assets/seedqueue/textures/gui/wall/lock.png"        -> Uint8Array
//   "assets/seedqueue/sounds.json"                       -> string (JSON)
//   "assets/seedqueue/sounds/lock_instance.ogg"          -> Uint8Array
```

`buildPack` は `WallState` から `VirtualPack` を生成する純関数。背景 PNG の Canvas 描画や無効時の
透明プレースホルダ生成は内部で `OffscreenCanvas`/`HTMLCanvasElement` を使うが、結果は `Uint8Array` として確定させ、
I/O は持たない。ユーザがアップロードした lock 画像はリサイズせずそのまま格納する。

> `buildPack` は Canvas に依存するため、**ブラウザ / Tauri webview 専用**とする（Node では動かさない、第10章 Phase 2 参照）。
> 音声の ogg 変換は `buildPack` の内部では行わない。**変換はアップロード時に済ませ、`WallState` には変換済み ogg
> バイト（または data URL）を持たせる**。これにより `buildPack` は決定的かつ高速に保たれる（第7章）。

### 4.3 アダプタ・インターフェース

```ts
// adapters/types.ts
export interface PackWriter {
  /** VirtualPack を環境に応じた形で出力する */
  write(pack: VirtualPack, packName: string): Promise<void>;
}

export interface PackReader {
  /** ユーザに選ばせたパック（.zip/フォルダ）を VirtualPack として読み込む */
  read(): Promise<VirtualPack>;
}
```

- `adapters/web.ts`：`WebPackWriter`（JSZip で zip 化し `URL.createObjectURL` でダウンロード）、
  `WebPackReader`（`<input type=file>` で .zip を受け取り JSZip で展開）。
- `adapters/desktop.ts`：`DesktopPackWriter` / `DesktopPackReader`（Tauri、第5章）。**動的 import で読み込む**。

### 4.4 アダプタ選択

```ts
// adapters/index.ts
export const isTauri = (): boolean =>
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

> `@tauri-apps/*` を静的 import すると Web バンドルがモジュール解決に失敗するため、
> デスクトップアダプタは必ず動的 import にする。

### 4.5 座標系（`core/coords.ts`）

レイアウト座標の計算を**1モジュールに集約**する。旧実装は座標変換が `setResolution`・プレビューのドラッグ処理・
import の percentage 変換などに散在し、ズレや小数の混入を招いていた。新実装では以下を `core/coords.ts` の責務とする。

- 「プレビュー上の px ↔ 実解像度 px」の相互変換（プレビュー・エクスポート・インポートで同一関数を使う）。
- 解像度変更時のエリア＋背景レイヤ座標の一括スケール。
- **境界での整数化：エクスポートおよび state 反映時に、座標・サイズ（`x`/`y`/`width`/`height`）を
  `Math.floor` で切り捨てて整数にする。** 旧実装は切り上げも切り捨てもせず、成果物の JSON に小数が混入していた。
  ドラッグ入力側でも floor を適用し、state に小数を持ち込まない。

---

## 5. Web / Desktop 分岐（Tauri 2）

前提：Tauri は安定版 v2 系（2026年時点 v2.10.x）。`dialog` / `fs` プラグイン使用。

### 5.1 デスクトップ書き出しフロー

1. `dialog` プラグインの `open({ directory: true, defaultPath: <homeDir> })` で出力先を選択。
   **`.minecraft` 等の自動検出は行わない**（MCSR では MultiMC/Prism のインスタンス別フォルダが一般的で外しやすいため）。
   初回ダイアログの既定パスはホームディレクトリ（`@tauri-apps/api/path` の `homeDir()`）とする。
2. 選択パスを `tauri-plugin-store` に保存し、次回以降は記憶した値を既定にする（「選ばせて記憶する」が基本動作）。
3. `VirtualPack` を **Rust 側 `write_pack` command** に渡し、フォルダ（推奨）または `.zip` として書き出す。
   - Minecraft はフォルダ形式のパックを読めるため unzip 不要。
   - 大容量バイナリ（背景 PNG・ogg）はフロントから fs プラグイン経由で書くより、Rust 側で
     `std::fs` / `tokio::fs` を使って一括書き込みする方がスコープ管理が単純で IPC も速い。

```rust
// src-tauri/src/lib.rs (概念)
#[tauri::command]
async fn write_pack(dir: String, files: Vec<PackFile>) -> Result<(), String> {
    // files: { path: String, bytes: Vec<u8> }
    // dir/<path> へ親ディレクトリ作成しつつ書き込む。path traversal は事前検証。
}
```

### 5.2 権限・スコープ（`src-tauri/capabilities/`）

- `dialog:allow-open` / `dialog:allow-save` / `dialog:allow-message`。
- `fs` を使う場合はスコープを最小化（`$RESOURCE` 等の base directory 基準）。
  `write_pack` を独自 command にする場合、fs プラグインのフロント API スコープは不要にできる。
- `requireLiteralLeadingDot: false`（`.minecraft` のようなドットディレクトリを扱うため）。

### 5.3 デスクトップ固有の機能拡充候補

- 既存パックフォルダ/zip の読込 → 編集 → 上書き保存（`PackReader` + `parsePack`）。
- 書き出し後にエクスプローラ/Finder でフォルダを開く（`opener` プラグイン）。
- 出力先を記憶したワンクリック再書き出し。

「直接いじる」を**書き込みのみ**とするか**読込＋書込の双方向**まで含めるかは、機能拡充スコープとして要決定。

---

## 6. リソースパックフォーマット仕様（SeedQueue 本体ソース由来＝絶対的な正）

本章は SeedQueue 本体（`contariaa/seedqueue`）のソースを直接読んで確定した仕様であり、**これを絶対的な正とする**。
旧 `packExport.ts` の挙動ではなく、以下のソースに基づく。実装・実機検証はすべてこの章を基準とする。

- レイアウト：`customization/Layout.java`
- ロックテクスチャ：`customization/LockTexture.java`（＋ `LockTextureMetadata` / `MainLockTextureMetadata`）
- テクスチャ識別子：`gui/wall/SeedQueueWallScreen.java`
- サウンドイベント：`sounds/SeedQueueSounds.java`、既定 `assets/seedqueue/sounds.json`
- アニメーション：`customization/AnimatedTexture.java`

### 6.1 フォルダ構成と識別子

SeedQueue が参照するリソース識別子（`assets/seedqueue/` 配下）。括弧内はソース上の定数名。

```
<pack>/
├─ pack.mcmeta
├─ pack.png                                            (任意: アイコン)
└─ assets/seedqueue/
   ├─ wall/custom_layout.json                          (CUSTOM_LAYOUT)
   ├─ textures/gui/wall/background.png                 (WALL_BACKGROUND・任意・アニメ可)
   ├─ textures/gui/wall/overlay.png                    (WALL_OVERLAY・任意・アニメ可)
   ├─ textures/gui/wall/instance_background.png        (INSTANCE_BACKGROUND・任意・アニメ可)
   ├─ textures/gui/wall/instance_overlay.png           (INSTANCE_OVERLAY・任意・アニメ可)
   ├─ textures/gui/wall/lock.png                        (lock・任意・アニメ可)
   ├─ textures/gui/wall/lock-1.png, lock-2.png, ...     (追加 lock・任意)
   ├─ sounds.json                                       (任意・上書きするイベントのみ)
   └─ sounds/<event>.ogg                                (カスタム音のときのみ)
```

各テクスチャは**存在する場合のみ**読み込まれる（`AnimatedTexture.of` が `containsResource` で判定）。
旧アプリは background と lock しか出力しないが、`overlay` / `instance_background` / `instance_overlay` も
正式なスロットであり、機能拡充の対象になり得る。

### 6.2 pack.mcmeta

```json
{ "pack": { "pack_format": 5, "description": "<説明>" } }
```

- `pack_format: 5` で固定（名前付き定数）。SeedQueue は 1.15.2 / 1.16.1 用のみ公開され、**両方とも pack_format 5**。

### 6.3 custom_layout.json

`Layout.fromJson` / `Group.fromJson` が読む構造。**トップレベル**:

| キー | 型 | 必須 | 既定 | 備考 |
|------|----|------|------|------|
| `main` | Group | ✓ | — | `cosmetic: true` は不可（例外）。`rows`/`columns` 省略時は SeedQueue 設定値 |
| `locked` | Group | — | なし | 省略時はロック列なし |
| `preparing` | Group **または Group の配列** | — | なし | SeedQueue は配列も受け付ける（複数 preparing グループ可） |
| `replaceLockedInstances` | boolean | — | `false` | — |
| `mainFillOrder` | `"FORWARD"`/`"BACKWARD"`/`"RANDOM"` | — | `FORWARD` | main の埋め順 |

**Group** は「グリッド指定」または「`positions` 明示指定」のいずれか:

| キー | 型 | 既定 | 備考 |
|------|----|------|------|
| `x` `y` `width` `height` | number | framebuffer サイズ | **数値の意味は 6.3.1 参照（整数=絶対px / 小数=割合）** |
| `rows` `columns` | int | main のみ設定値、他は必須 | グリッド分割数。**1 以上の整数必須**（0/負/小数は不可） |
| `padding` | int | `0` | インスタンス間の間隔(px) |
| `positions` | `{x,y,width,height}` の配列 | — | 指定時は rows/columns を使わず各位置を直接指定 |
| `cosmetic` | boolean | `false` | 表示専用グループ（main は不可） |
| `instance_background` | boolean | `true` | このグループでインスタンス背景を描画するか |
| `instance_overlay` | boolean | `true` | このグループでインスタンスオーバーレイを描画するか |

#### 6.3.1 数値の意味（最重要・旧アプリのバグの正体）

`x` / `y` / `width` / `height` は `getAsInt` で読まれ、**値の表記で意味が変わる**:

- **小数点を含む数値（例 `0.85`）＝ framebuffer に対する割合**。`x`/`width` は幅、`y`/`height` は高さに乗算される。
- **小数点を含まない整数（例 `1632`）＝ 絶対ピクセル**。

本アプリは「解像度を選んで絶対px で編集する」モデルなので、**出力は必ず整数（小数点なし）にしなければならない**。
`1632.0` のように小数点付きで出すと SeedQueue は「framebuffer 幅 × 1632.0」と解釈し、レイアウトが完全に壊れる。
→ 第4.5章の「`Math.floor` 整数化」は美観ではなく**正しさの要件**。旧アプリの JSON に小数が混入していた件は、
この割合解釈に化けてレイアウトを破壊する実バグだった。

#### 6.3.2 アプリ内部フラグの strip

`useGrid` / `show` はアプリ内部の状態であり SeedQueue 仕様には存在しない。エクスポート時に削除する。
`useGrid === false` のグループは `rows`/`columns` を出さない（`positions` 方式に切替える設計も可）。
`padding` が 0 のときは省略してよい。`locked`/`preparing` は表示時のみ出力する。

### 6.4 テクスチャ（背景・オーバーレイ・インスタンス）

`background.png` / `overlay.png` / `instance_background.png` / `instance_overlay.png` はいずれも任意。
背景は解像度サイズの PNG を Canvas 合成（color/image/gradient、各 `opacity`）して生成する（従来通り）。
全テクスチャは **MC 標準のアニメーション `.mcmeta`**（縦フレームストリップ + `AnimationResourceMetadata`）に対応。
旧アプリは静止背景のみ。アニメ背景・overlay・instance テクスチャは機能拡充の候補。

### 6.5 lock 画像（番号付けに旧アプリのバグあり）

SeedQueue（`LockTexture.createLockTextures`）の読み込み順は厳密に次の通り:

1. 最初に **必ず `lock.png`** を読む。
2. 以降、`lock-1.png` → `lock-2.png` → … と、**1 から始まる連番**を、存在する限り読み続ける。

つまり **複数画像でも 1 枚目は必ず `lock.png`、2 枚目以降が `lock-1.png`, `lock-2.png`, …**。

- **正しい出力**：N 枚なら `lock.png`(1枚目), `lock-1.png`(2枚目), `lock-2.png`(3枚目), …
- **旧アプリのバグ**：2 枚以上のとき `lock.png` を作らず `lock-1.png` から始めていた。SeedQueue は `lock.png` の
  読み込みに失敗すると `lock-1.png` 以降を**一切探さない**ため、ロック画像が 1 枚も読まれない。新実装で是正する。
- サイズ自由（既定 lock.png は 16x26）。SeedQueue は読み込んだ寸法でアスペクト比を保持する。**正方形/固定サイズ要件はない**。
- 無効化：透明 PNG を `lock.png` として上書きする（プレースホルダ。サイズはアプリ任意で 128x128 とする）。
  ファイルを置かないと MOD 既定の lock.png にフォールバックするため、無効化には透明上書きが必要。
- 任意のメタ：`<lock>.png.mcmeta` に `{"seedqueue": {"weight": N}}` で重み付き抽選、`lock.png` には
  `{"seedqueue": {"defaultWeight": N}}` で既定重み。lock もアニメ可。いずれも機能拡充の候補。

### 6.6 sounds.json / sounds

SeedQueue のサウンドイベントは **13 種**（`SeedQueueSounds.java`）。既定 `sounds.json` は `lock_instance` と
`reset_instance` のみ内蔵音を指し、他は空。

| イベントキー | 内容 | 既定で音あり |
|--------------|------|------|
| `play_instance` | インスタンス参加 | — |
| `lock_instance` | インスタンスロック | ✓ |
| `reset_instance` | 単一インスタンスのリセット | ✓ |
| `reset_all` | 全リセット | — |
| `reset_column` | 列リセット | — |
| `reset_row` | 行リセット | — |
| `schedule_join` | 参加予約 | — |
| `schedule_all` | 全予約 | — |
| `scheduled_join_warning` | 予約参加の警告 | — |
| `start_benchmark` | ベンチ開始 | — |
| `finish_benchmark` | ベンチ終了 | — |
| `open_wall` | Wall を開く | — |
| `bypass_wall` | Wall をバイパス | — |

`sounds.json` の各エントリは `{ "sounds": ["seedqueue:<name>" または "<file>"] }`。MC の規則上、上書き時に
既定音と二重再生させないため**上書きするイベントには `"replace": true` を付ける**。`sounds: []` で無音。

- **default（内蔵音を使う）**：そのイベントを `sounds.json` に書かない（MOD 既定にフォールバック）。
- **off（無音）**：`{ "replace": true, "sounds": [] }`。
- **custom（独自音）**：`assets/seedqueue/sounds/<event>.ogg` を配置し `{ "replace": true, "sounds": ["<event>.ogg"] }`。

> 旧アプリは 6 イベントしか扱わず、`reset_instance` を独立イベントとして扱わない・`play_instance`/`schedule_*`/
> `open_wall`/`bypass_wall`/`scheduled_join_warning` を欠いていた。新実装は 13 イベントを正として UI を設計する
> （全部出すのではなく、ユーザが変更したイベントのみ `replace: true` で出力するのが簡潔）。

### 6.7 旧アプリとの差分（是正すべきバグ・未対応）

1. **小数出力**：絶対px のつもりの小数が SeedQueue では割合と解釈されレイアウト破壊（6.3.1）。→ 整数化。
2. **lock 複数画像の番号**：`lock.png` を作らず `lock-1.png` 始まりで全滅（6.5）。→ 1枚目を `lock.png` に。
3. **サウンドイベント不足**：6/13 のみ。`reset_instance` 等を欠く（6.6）。→ 13 イベント対応。
4. **未対応スロット**：`overlay` / `instance_background` / `instance_overlay`、`mainFillOrder`、Group の
   `cosmetic`/`instance_*`、`preparing` 配列、lock の weight・アニメ。→ 機能拡充候補として整理。

---

## 7. データモデル再設計

### 7.1 単一の正規 state

`buildPack` と `parsePack` は同じ `WallState` を入出力する。旧実装の最大の負債は
**import が旧フラットモデル（`type`/`image`/`imageLayers`/`gradientStart` 等）を作るのに、store は
レイヤ配列モデル（`background.layers`）を使っており不整合**だった点。新実装では `WallState` を唯一の真実とする。

```ts
// core/state.ts
export interface WallState {
  resolution: { width: number; height: number };
  layout: {
    main: Area;
    locked: Area & { show: boolean };
    preparing: Area & { show: boolean };
  };
  background: { layers: BackgroundLayer[] };      // color | image | gradient の判別共用体配列
  packInfo: { name: string; description: string; icon: string | null };
  sounds: SoundSettings;
  lockImages: { enabled: boolean; images: string[] };
  replaceLockedInstances: boolean;
}

interface Area {
  x: number; y: number; width: number; height: number;
  rows: number; columns: number;
  useGrid?: boolean;   // 内部専用（エクスポート時に strip）
  padding?: number;
}
```

`BackgroundLayer` は旧 store の判別共用体（`ColorLayer` | `ImageLayer` | `GradientLayer`）を踏襲。
`parsePack` は背景 PNG を 1枚の `ImageLayer` として復元し、必ず `layers` 配列に載せる（旧バグの修正）。

### 7.2 store

- Zustand 5。UI 状態（`selectedArea` 等）とドメイン state を分離。
- **永続化は2層に分ける**（base64 を素朴に全部 persist すると localStorage 上限を超えるため）。
  - 軽い state（レイアウト・色・各種設定値）：`zustand/middleware` の `persist`。Desktop は `tauri-plugin-store`。
  - 画像・音声などのバイナリ（背景画像・lock 画像・アイコン・サウンド）は **JSON/store に載せず逃がす**：
    - **Web**：IndexedDB に保存（blob 向きで上限も大きい）。
    - **Desktop**：`tauri-plugin-store`(JSON) には入れず、**appDataDir 配下に実ファイルとして書き出す**。
  - どちらも **state に永続化するのは参照（キー/相対パス）のみ**とし、ロード時に参照からバイナリを復元する。
    インメモリの `WallState` は従来どおりバイナリ（data URL/bytes）を保持し、`buildPack`・プレビューはそれを使う。
- 「重い部分（バイナリ）は最初からファイル/IDB へ逃がす」方針を採用する。これにより persist/store が扱うのは
  常に軽量 state のみになり、サイズ閾値の監視なしにバイナリ肥大化による破綻を構造的に防ぐ。
- IndexedDB は非同期のため、`persist` には**非同期 StateStorage アダプタ**を実装する。
  ストレージ層（IDB / appDataDir ファイル）は差し替え可能に保つ。
- 座標・スケール処理は `core/coords.ts`（第4.5章）に集約し、store からはそれを呼ぶだけにする。
  `setResolution` のスケールはエリアと背景レイヤ座標の両方に適用する（旧実装はエリアのみでズレた）。
- `any` を排し、`updateLayer` 等は判別共用体に対して型安全に実装する。

### 7.3 入力バリデーションと音声変換

自動テストをしない方針（第2.3章）のため、**不正なパックをそもそも生成させないガード**を state／UI 段に置く。

- **`rows` / `columns`**：main・locked・preparing いずれも、**1 以上の整数**のみ許可する（0・負値・小数は不可）。
  小数や 0 は SeedQueue 側でグリッド分割の 0 除算・破綻を招くため（第6.3章）、入力段で弾く。
- **座標・サイズ**：`Math.floor` で整数化（第4.5章・第6.3.1章）。負の幅/高さは禁止。
- **エリアの重なり**：重なっても SeedQueue 動作上は問題ないため、**バリデーションしない**（許容する）。
- **音声**：アップロード時に ffmpeg.wasm で ogg へ変換し、変換済みバイトを `WallState` に格納する。
  `buildPack` は変換を行わず、保持済み ogg をそのまま `sounds/<event>.ogg` に書く（第4.2章）。

---

## 8. 既知の不具合（リライトで解消する）

フォーマット系（第6章・SeedQueue ソースとの突き合わせで判明）:

1. **小数座標がレイアウト破壊**：絶対px のつもりの小数が SeedQueue では framebuffer 比率と解釈される（6.3.1）。→ 整数化。
2. **lock 複数画像が読まれない**：`lock.png` を作らず `lock-1.png` から始めるため SeedQueue が全滅（6.5）。→ 1枚目を `lock.png`。
3. **サウンドイベント不足**：6/13 イベントのみ、`reset_instance` を独立扱いしない（6.6）。→ 13 イベント対応。

アプリ内部の不整合:

4. `packExport.ts` の `preparing` 配列分岐がデッドコード（SeedQueue は配列対応だが旧アプリは単一のみ出力）。→ 整理。
5. import が背景レイヤモデルと不整合（`imageLayers`/`type`/`image` 等の旧フィールド）。→ `parsePack` で `layers` を正しく復元。
6. store の `importData` が浅いマージで `layers` が default のまま残る。→ `WallState` を丸ごと差し替える設計に。
7. `App.tsx` `handleImport` が存在しないフィールド（`imageCropWidth/Height`）を操作。→ 削除。
8. sounds の import 形（`lockInstanceReplace`/`playInstance` 等）が `SoundSettings` と不一致。→ `parsePack` で正規化。
9. `setResolution` が背景レイヤをスケールしない＋座標計算が散在。→ `core/coords.ts` に集約し境界で `Math.floor`。
10. `pack_format: 5` ハードコード。→ 名前付き定数化（1.15.2/1.16.1 とも format 5 で値は正しい）。
11. `audioConverter` が ffmpeg-core を unpkg からランタイム取得。→ self-host（第9章）。
12. 出力/入力に散在する `any`。→ 型付け。

---

## 9. スタック・その他

- **フロント**：React 19 / TypeScript / Vite 7。
- **スタイル**：Tailwind CSS v4（既存プロジェクトと整合）。bespoke UI を shadcn/ui ベースに置換するかは要検討
  （`DARK_MODE_GUIDE.md` のテーマ移植コストとのトレードオフ）。
- **状態**：Zustand 5 + `persist`（2層永続化、第7.2章）。
- **デスクトップ**：Tauri 2（Rust シェル、`dialog`/`fs`/`store`/`opener` プラグイン）。
- **配布**：対象は **Windows + macOS**。両 OS の実機でビルドするため CI は必須としない。
  **自動更新なし**（`tauri-plugin-updater` は導入しない）。**署名は最小限**。
  → macOS は notarization 無しで Gatekeeper 警告（初回は右クリック→開く）、Windows は未署名で SmartScreen 警告が出る点は許容する。
- **ZIP**：JSZip（Web アダプタ）。
- **音声**：ffmpeg.wasm を両環境で共有。**ffmpeg-core を自前バンドル/ホスト**して unpkg 依存を排除。
  - Web では SharedArrayBuffer に COOP/COEP ヘッダが必要（Vercel なら `vercel.json`/headers で付与）。
  - Tauri webview では不要。将来、デスクトップのみ Rust 側変換に切替える選択肢も残す。
  - **ライセンス表記**：FFmpeg のライセンス表記を README とアプリ内（About/ライセンス画面）に掲載する。
- **検証**：自動比較テストは行わない（第2.3章）。代表パターンを出力し、Minecraft 実機で読み込んで検証する。
- **パフォーマンス**：4K 背景生成＋複数 lock＋ZIP 化は UI をブロックしうるため、Web では `buildPack`／zip を
  **Web Worker** に逃がし、進捗表示を出す（Tauri は Rust 側 `write_pack` で吸収）。
- **エラー UX**：現行の `alert()` 依存をやめ、**トースト等の非ブロッキングなエラー表示**に統一する（品質向上の一部）。
- **共有 URL**：旧形式（`?layout=<base64>`）の互換は**サポート対象外**（利用実績が確認できないため）。新形式で再設計してよい。
- **OGP/SSR**：旧 `api/index.ts` は Vercel serverless 前提。静的配信（Tauri と相性が良い）に倒す場合は
  ビルド時 OGP 埋め込み or 共有 URL ごとの静的化を検討。Web デプロイ方針確定後に決定。

---

## 10. 段階的実装計画

| Phase | 内容 | 完了条件 |
|-------|------|----------|
| 0 | SeedQueue ソース由来仕様（第6章）の確定 ＋ 検証パターン定義（第2.3章） | 仕様（絶対的な正）と検証パターンが確定 |
| 1 | 新 repo scaffold（Vite + React + TS + Tailwind v4） | `pnpm dev` が起動 |
| 2 | core 層：型定義 + `core/coords.ts`（座標変換・floor 整数化）+ `buildPack` + Canvas 描画移植（背景 PNG・透明プレースホルダ） | 簡易 UI/webview から生成した最小パックが Minecraft で読み込める（`buildPack` は webview 専用、Node では実行しない） |
| 3 | store 再設計（layers モデル統一 + 2層永続化 + coords 連携） | 設定操作が型安全に反映、リロードで復元 |
| 4 | UI 移植（`components/ui`, タブ, 各エディタ, `WallPreview` の座標系を coords に統一） | プレビューが state と同期し小数が出ない |
| 5 | `parsePack`（import）実装 | 生成パックを再インポートしてエディタ状態が復元される |
| 6 | Web アダプタ（JSZip + download） | Web 単体で機能完結し、代表パターンが Minecraft で動作 |
| 7 | Tauri 導入（`src-tauri`, `write_pack` command, dialog, store scope） | デスクトップで直接書き出し成功 |
| 8 | Desktop アダプタ + 既存パック読込編集（機能拡充） | パックフォルダの読込→編集→保存 |
| 9 | 仕上げ（i18n, 共有 URL, OGP, FFmpeg ライセンス表記, Win/Mac ビルド・最小署名） | Web/Desktop（Win+Mac）両方リリース可能 |

Phase 6 の時点で「従来機能を完全に満たす Web 版」が完成し、Phase 7 以降がデスクトップ拡張になる。
これにより、リスクの高い Tauri 部分を後段に隔離しつつ、早期に動くものを得られる。
検証は各 Phase で代表パターンを実機（Minecraft）に読み込ませて確認する（第2.3章）。

---

## 11. 次のタスク（Claude Code 引き継ぎ）

Phase 1〜2 の最初の具体作業として、**`WallState` / `SoundSettings` / `BackgroundLayer` の型定義一式と、
`buildPack` / `coords` のシグネチャ草案を起こす**。実装本体ではなく、型と関数シグネチャ（＋最小スタブ）が成果物。

### 前提（プロジェクト雛形）

開発環境は **Windows**。本仕様の第9章スタックで scaffold 済みであること（Vite + React-TS + Tauri 2 + Tailwind v4）。
型定義は `src/core/` 配下に置く。配布対象は Win + Mac だが、Mac ビルドは Mac 実機で行う。

### 成果物

1. **`src/core/state.ts`** — ドメイン状態の型一式:
   - `Resolution`、`Area`（`x/y/width/height` は整数px、`rows`/`columns` は **1以上の整数**、`useGrid?`/`padding?` は内部用）。
   - `BackgroundLayer` = `ColorLayer | ImageLayer | GradientLayer` の判別共用体（`type` で判別。旧 store の構造を踏襲、第7.1章）。
   - `SoundSettings` — **第6.6章の全13イベントを表現できる形に再設計**（旧6イベント設計は破棄）。
     各イベントは `'default' | 'off' | 'custom'`＋カスタム時の変換済み ogg バイト参照を持てること。`reset_instance` は独立イベント。
   - `LockImages`、`PackInfo`、`WallState`（第7.1章のスケルトンを正とする）。
2. **`src/core/types.ts`** — `VirtualPack = Map<string, Uint8Array | string>`、`PackWriter` / `PackReader` インターフェース（第4.3章）。
3. **`src/core/buildPack.ts`** — シグネチャ草案＋スタブ:
   - `export async function buildPack(state: WallState): Promise<VirtualPack>`（Canvas/`toBlob` 利用のため async・webview 専用）。
   - 音声変換は含めない（変換済みバイトは `WallState` 側に保持、第4.2章）。
4. **`src/core/coords.ts`** — シグネチャ草案＋スタブ:
   - プレビューpx ↔ 実解像度px の相互変換、解像度変更時のエリア＋背景レイヤの一括スケール、
     `Math.floor` による整数化を行う関数群（第4.5章）。境界整数化は coords に集約する。

### 受け入れ条件

- TypeScript strict でコンパイルが通り、`any` を使っていない。
- `SoundSettings` が第6.6章の13イベントを漏れなく表現できる。
- `Area.rows`/`columns` の不変条件（1以上の整数）をコメント＋（後続実装用の）バリデーション関数シグネチャで明示。
- `buildPack` は `Promise<VirtualPack>` を返す。`coords` は変換・スケール・floor を公開する。
- すべて第6章（SeedQueue ソース由来＝絶対的な正）と矛盾しないこと。

### 補足

`parsePack` の型・シグネチャは本タスクの直後（Phase 5 着手時）に、`buildPack` と対になる形で起こす。
本タスクでは `buildPack` / `coords` を優先する。
