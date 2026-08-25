// SeedQueue Wall Maker — Tauri 2 backend.
//
// 役割: フロント (`adapters/desktop.ts`) からのファイル I/O 要求を最小表面積で受ける。
// `tauri-plugin-fs` のフロント API スコープを開けずに、専用コマンドだけ公開する。
// 仕様: REWRITE_SPEC.md 第10章 Phase 7-8 / CLAUDE.md「Desktop 機能を足す」。
//
// 公開コマンド:
//  * `write_pack_folder` — VirtualPack を root フォルダ直下に展開（既存内容は削除して上書き）
//  * `write_file`        — 任意パスに 1 ファイルを書き出す（.zip エクスポート用）
//  * `read_pack_zip`     — 任意の .zip パスを丸ごと生バイトで返す
//  * `read_pack_folder`  — 任意のフォルダを再帰 walk し、相対パス付きの生バイトで返す
//  * `path_is_dir`       — 指定パスが実在するフォルダかを返す（記憶した保存先の存在検証用）
//  * `binary_put` / `binary_get` / `binary_delete` / `binary_keys`
//    — 永続化バイナリ（画像/音声）の実体ストア。appDataDir/binaries/<key> に置く
//      （フロントの `store/storage/desktop.ts` が使う。CLAUDE.md 第7.2章）
//
// 設計メモ:
//  * パストラバーサル（`..`）や絶対パスを VirtualPack のキーとして含めない（書込側で拒否）。
//  * シンボリックリンクは追わない（無視）。
//  * Zip 生成・展開は JS 側（JSZip）で行う。Rust に zip クレートを足さない。
//
// バイナリ IPC は **生バイト**で往復させる（serde 既定の JSON 数値配列を使わない）:
//  * `Vec<u8>` を素直に返す／受けると、serde が 10 進数値の JSON テキスト
//    （`[137,80,78,71,...]`）に展開する。20MB の画像が 60〜70MB のテキスト＋
//    2000 万要素の JS 配列になり、Desktop 最大のボトルネックになっていた。
//  * 戻り方向は `tauri::ipc::Response::new(bytes)`（`InvokeResponseBody::Raw`）。
//    JS には `ArrayBuffer` がそのまま届く。
//  * 引数方向は `tauri::ipc::Request` の生ボディ。Tauri 2 の `invoke` は
//    **引数全体が ArrayBuffer / TypedArray のときだけ** `application/octet-stream`
//    として送るため、メタ情報とバイト列を 1 本のコンテナに詰めて渡す:
//        `[u32 LE metaLen][meta JSON (UTF-8)][payload ...]`
//    （{@link split_ipc_container} / フロント側 `encodeIpcContainer` が対）。

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

// ---------------------------------------------------------------------------
// 生バイト IPC コンテナ
// ---------------------------------------------------------------------------

/// invoke の生ボディを取り出す。
///
/// 通常は custom protocol IPC 経由で `InvokeBody::Raw` が届く。custom protocol が
/// 使えない webview では Tauri が postMessage にフォールバックし、その経路では
/// 生ボディを運べず JSON 数値配列になるため、互換のため受けておく（低速だが動く）。
fn raw_invoke_body<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(value) => {
            let arr = value
                .as_array()
                .ok_or("IPC ボディが生バイトでも数値配列でもありません")?;
            let mut out = Vec::with_capacity(arr.len());
            for v in arr {
                let n = v
                    .as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or("IPC ボディの数値配列に 0-255 以外の値が含まれています")?;
                out.push(n);
            }
            Ok(Cow::Owned(out))
        }
    }
}

/// `[u32 LE metaLen][meta JSON][payload]` を (meta, payload) に分解する。
fn split_ipc_container(raw: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let len_bytes: [u8; 4] = raw
        .get(..4)
        .and_then(|s| s.try_into().ok())
        .ok_or("IPC コンテナが不正です（メタ長ヘッダが読めません）")?;
    let meta_len = u32::from_le_bytes(len_bytes) as usize;
    let rest = &raw[4..];
    if rest.len() < meta_len {
        return Err("IPC コンテナが不正です（メタ部が切り詰められています）".to_string());
    }
    Ok(rest.split_at(meta_len))
}

/// 生ボディのコンテナから meta を deserialize し、payload スライスと一緒に返す。
fn parse_ipc_container<'a, M: serde::de::DeserializeOwned>(
    raw: &'a [u8],
) -> Result<(M, &'a [u8]), String> {
    let (meta_bytes, payload) = split_ipc_container(raw)?;
    let meta = serde_json::from_slice::<M>(meta_bytes)
        .map_err(|e| format!("IPC コンテナの meta を解釈できません: {e}"))?;
    Ok((meta, payload))
}

/// `write_pack_folder` / `read_pack_folder` の 1 ファイル分のメタ。
#[derive(Deserialize, Serialize)]
struct PackFileMeta<S> {
    path: S,
    len: usize,
}

#[derive(Deserialize)]
struct WritePackMeta {
    root: String,
    files: Vec<PackFileMeta<String>>,
}

#[derive(Deserialize)]
struct WriteFileMeta {
    path: String,
}

#[derive(Deserialize)]
struct BinaryPutMeta {
    key: String,
}

#[derive(Serialize)]
struct ReadPackMeta<'a> {
    files: Vec<PackFileMeta<&'a str>>,
}

/// VirtualPack を `<root>/` 直下に展開する（root 自体がパックフォルダ）。
///
/// 引数は生バイトコンテナ（冒頭の設計メモ参照）:
///  - meta    : `{ "root": string, "files": [{ "path": string, "len": number }, ...] }`
///              `root` はパックの root 絶対パス。同名フォルダがあれば**内容ごと削除して
///              上書き**する。親フォルダは事前に存在している前提（無ければエラー）。
///              `path` はパック内相対パス（POSIX 区切り）。
///  - payload : `files` の順に連結したバイト列。
///
/// 「名前を付けて保存」と「上書き保存」の両方で本コマンドを使う。命名は呼び出し側
/// （フロント）の責務で、Rust 側は受け取った root をそのまま使う。
///
/// 返り値: 書き出した root の絶対パス（toast 表示用）。
/// `write_pack_folder` が既存フォルダを再帰削除してよいかを判定する。
///
/// 削除は破壊的で取り消せないため、次のどちらかを満たすときだけ許可する:
///   * フォルダが空である（新規保存で作られた直後など）
///   * 直下に `pack.mcmeta` か `assets` がある（＝リソースパックとして書かれたフォルダ）
///
/// これに当たらないフォルダ（`resourcepacks` の親、`Downloads`、ホーム等）は、
/// フロント側がパスを取り違えていても中身を失わずに済む。
fn is_safe_to_replace(root: &Path) -> Result<bool, String> {
    if root.join("pack.mcmeta").exists() || root.join("assets").is_dir() {
        return Ok(true);
    }
    let mut entries = fs::read_dir(root)
        .map_err(|e| format!("フォルダ読み取りに失敗 {}: {e}", root.display()))?;
    Ok(entries.next().is_none())
}

#[tauri::command]
fn write_pack_folder(request: Request<'_>) -> Result<String, String> {
    let raw = raw_invoke_body(&request)?;
    let (meta, payload) = parse_ipc_container::<WritePackMeta>(&raw)?;
    let root_path = PathBuf::from(&meta.root);

    // 入力の検証は**破壊的操作（既存フォルダ削除）より先**にすべて済ませる。
    // 途中で気づくと、既存パックを消したあと中途半端な内容だけが残る。
    let declared: usize = meta
        .files
        .iter()
        .try_fold(0usize, |acc, f| acc.checked_add(f.len))
        .ok_or("IPC コンテナのファイル長合計が桁溢れしました")?;
    if declared != payload.len() {
        return Err(format!(
            "IPC コンテナの長さが不整合です（meta 合計 {declared} / payload {}）",
            payload.len()
        ));
    }
    for entry in &meta.files {
        let rel_path = &entry.path;
        // パストラバーサル防止: 区切りを `/` `\` 双方で見て `..` セグメントを禁止。
        if rel_path
            .split(|c| c == '/' || c == '\\')
            .any(|seg| seg == ".." || seg.is_empty())
        {
            return Err(format!(
                "不正なパス（\"..\" もしくは空セグメント）: {rel_path}"
            ));
        }
        if Path::new(rel_path).is_absolute() {
            return Err(format!("不正なパス（絶対パス）: {rel_path}"));
        }
    }

    // 親フォルダは必須。root 自体は存在しなくてもよい（新規作成）。
    if let Some(parent) = root_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "出力先の親フォルダが存在しません: {}",
                parent.display()
            ));
        }
    }

    // 既存パックを完全上書きする。ファイルだった場合は事故防止のため拒否。
    if root_path.exists() {
        if root_path.is_file() {
            return Err(format!(
                "出力先 {} は既にファイルとして存在します",
                root_path.display()
            ));
        }
        // ここは root ごと再帰削除する。フロント側が保存先パスを1つ間違えるだけで
        // `.minecraft/resourcepacks/` やホームディレクトリが丸ごと消えるため、
        // 「空」か「リソースパックに見える」フォルダ以外は削除せず拒否する。
        if !is_safe_to_replace(&root_path)? {
            return Err(format!(
                "出力先 {} はリソースパックではないフォルダです（空でも pack.mcmeta / assets を含むものでもないため、上書きを中止しました）",
                root_path.display()
            ));
        }
        fs::remove_dir_all(&root_path).map_err(|e| {
            format!("既存フォルダ削除に失敗 {}: {e}", root_path.display())
        })?;
    }
    fs::create_dir_all(&root_path)
        .map_err(|e| format!("フォルダ作成に失敗 {}: {e}", root_path.display()))?;

    let mut offset: usize = 0;
    for entry in &meta.files {
        let rel_path = &entry.path;
        // payload の切り出し。合計長は上で検証済みなので範囲外にはならない。
        let end = offset + entry.len;
        let bytes = &payload[offset..end];
        offset = end;

        let target = root_path.join(rel_path);
        if let Some(parent_dir) = target.parent() {
            fs::create_dir_all(parent_dir).map_err(|e| {
                format!("親フォルダ作成に失敗 {}: {e}", parent_dir.display())
            })?;
        }
        fs::write(&target, bytes)
            .map_err(|e| format!("書き込みに失敗 {}: {e}", target.display()))?;
    }

    Ok(root_path.to_string_lossy().to_string())
}

/// 任意パスに 1 ファイルを書き出す（`.zip` エクスポートで使用）。
/// 親フォルダは事前に存在している前提（無ければエラー）。
///
/// 引数は生バイトコンテナ: meta `{ "path": string }` + payload（ファイル本体）。
/// パスはヘッダではなく meta に載せる（非 ASCII なフォルダ名を扱うため）。
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<String, String> {
    let raw = raw_invoke_body(&request)?;
    let (meta, payload) = parse_ipc_container::<WriteFileMeta>(&raw)?;
    let p = PathBuf::from(&meta.path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "出力先の親フォルダが存在しません: {}",
                parent.display()
            ));
        }
    }
    fs::write(&p, payload)
        .map_err(|e| format!("書き込みに失敗 {}: {e}", p.display()))?;
    Ok(p.to_string_lossy().to_string())
}

/// 任意の .zip ファイルを丸ごとバイナリで返す（生バイト応答＝JS には ArrayBuffer）。
/// Zip 展開は JS 側（`zipFileToVirtualPack`）で行う。
#[tauri::command]
fn read_pack_zip(path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("ファイルが存在しません: {}", p.display()));
    }
    fs::read(&p)
        .map(Response::new)
        .map_err(|e| format!("読み込み失敗 {}: {e}", p.display()))
}

/// 指定フォルダを再帰 walk し、生バイトコンテナ
/// （meta `{ "files": [{ "path", "len" }, ...] }` + 連結バイト列）で返す。
/// 相対パスは POSIX 区切り（`/`）に揃える（VirtualPack 規約）。
/// シンボリックリンクは追わない（metadata.is_file/is_dir 判定で除外される）。
#[tauri::command]
fn read_pack_folder(path: String) -> Result<Response, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("フォルダが存在しません: {}", root.display()));
    }
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    walk_dir(&root, &root, &mut files)?;

    // meta と payload の順序を必ず一致させるため、走査順を Vec に固定する。
    let entries: Vec<(String, Vec<u8>)> = files.into_iter().collect();
    let meta_bytes = {
        let meta = ReadPackMeta {
            files: entries
                .iter()
                .map(|(path, bytes)| PackFileMeta {
                    path: path.as_str(),
                    len: bytes.len(),
                })
                .collect(),
        };
        serde_json::to_vec(&meta).map_err(|e| format!("meta のシリアライズに失敗: {e}"))?
    };
    let meta_len = u32::try_from(meta_bytes.len())
        .map_err(|_| "meta が大きすぎます（4GiB 超）".to_string())?;

    let payload_len: usize = entries.iter().map(|(_, b)| b.len()).sum();
    let mut out = Vec::with_capacity(4 + meta_bytes.len() + payload_len);
    out.extend_from_slice(&meta_len.to_le_bytes());
    out.extend_from_slice(&meta_bytes);
    // `entries` を**所有権ごと**回す。コピー済みの Vec は各周回の終わりに drop され、
    // フォルダ全体を二重に抱えたままにならない。
    for (_, bytes) in entries {
        out.extend_from_slice(&bytes);
    }
    Ok(Response::new(out))
}

/// 指定パスが「実在するフォルダ」かを返す。
///
/// `tauri-plugin-store` に記憶した保存先（上書き保存の対象）が、前回終了後も
/// まだ存在するかを起動時に検証するために使う（`adapters/desktopSaveTarget.ts`）。
/// 読み取りのみで副作用は無く、存在しない／アクセスできない場合は素直に false。
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    !path.is_empty() && PathBuf::from(&path).is_dir()
}

fn walk_dir(
    root: &Path,
    current: &Path,
    out: &mut HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("read_dir 失敗 {}: {e}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry エラー: {e}"))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("metadata 失敗 {}: {e}", path.display()))?;
        if metadata.is_dir() {
            walk_dir(root, &path, out)?;
        } else if metadata.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| format!("strip_prefix 失敗 {}: {e}", path.display()))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let bytes = fs::read(&path)
                .map_err(|e| format!("read 失敗 {}: {e}", path.display()))?;
            out.insert(rel_str, bytes);
        }
        // それ以外（symlink / device など）は無視
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 永続化バイナリストア（appDataDir/binaries/<key>）
// 画像・音声の実体を JSON(store/localStorage) に載せないための逃がし先。
// fs プラグインのフロント API スコープを開けない方針のため、専用コマンドで閉じる。
// ---------------------------------------------------------------------------

/// キーはフロントが発行する UUID（英数字とハイフン）のみ許可。
/// パス区切りや `..` を含むキーで appDataDir 外へ書かれるのを防ぐ。
fn validate_binary_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!("不正なバイナリキー: {key}"));
    }
    Ok(())
}

fn binaries_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("appDataDir の取得に失敗: {e}"))?
        .join("binaries");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("binaries フォルダ作成に失敗 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 引数は生バイトコンテナ: meta `{ "key": string }` + payload（実体バイト列）。
#[tauri::command]
fn binary_put(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let raw = raw_invoke_body(&request)?;
    let (meta, payload) = parse_ipc_container::<BinaryPutMeta>(&raw)?;
    validate_binary_key(&meta.key)?;
    let path = binaries_dir(&app)?.join(&meta.key);
    fs::write(&path, payload)
        .map_err(|e| format!("バイナリ書き込みに失敗 {}: {e}", path.display()))
}

/// 生バイト応答には `null` を表す手段がないため、**先頭 1 バイトを在否フラグ**にする。
/// `0` = エントリ不在 / `1` = 実体あり（2 バイト目以降が中身）。
/// フロントの `DesktopBinaryStorage.get` がこのフラグを見て `null` に戻す。
#[tauri::command]
fn binary_get(app: tauri::AppHandle, key: String) -> Result<Response, String> {
    validate_binary_key(&key)?;
    let path = binaries_dir(&app)?.join(&key);
    if !path.is_file() {
        return Ok(Response::new(vec![0u8]));
    }
    // 先にフラグを積んでから read_to_end する（後付け prepend の全コピーを避ける）。
    let mut buf = vec![1u8];
    fs::File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| format!("バイナリ読み込みに失敗 {}: {e}", path.display()))?;
    Ok(Response::new(buf))
}

#[tauri::command]
fn binary_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    validate_binary_key(&key)?;
    let path = binaries_dir(&app)?.join(&key);
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path)
        .map_err(|e| format!("バイナリ削除に失敗 {}: {e}", path.display()))
}

#[tauri::command]
fn binary_keys(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = binaries_dir(&app)?;
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("read_dir 失敗 {}: {e}", dir.display()))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry エラー: {e}"))?;
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 外来ファイル（.DS_Store 等）はキーとして返さない。返すと GC が
        // binary_delete（validate_binary_key で拒否）に失敗し続けるため。
        if validate_binary_key(&name).is_ok() {
            out.push(name);
        }
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // OS 表示言語の取得（初期表示言語を OS に合わせるため）。フロントは `locale()` のみ使う。
        .plugin(tauri_plugin_os::init())
        // ウィンドウタイトルはバージョン（tauri.conf.json の `version`）と常に同期させる。
        // 静的タイトルだとバージョン更新時に追従漏れするため、起動時に動的に組み立てる。
        .setup(|app| {
            let title = format!(
                "SeedQueue Wall Maker - v{}",
                app.package_info().version
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&title);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_pack_folder,
            write_file,
            read_pack_zip,
            read_pack_folder,
            path_is_dir,
            binary_put,
            binary_get,
            binary_delete,
            binary_keys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
