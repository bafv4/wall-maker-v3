// SeedQueue Wall Maker — Tauri 2 backend.
//
// 役割: フロント (`adapters/desktop.ts`) からのファイル I/O 要求を最小表面積で受ける。
// `tauri-plugin-fs` のフロント API スコープを開けずに、専用コマンドだけ公開する。
// 仕様: REWRITE_SPEC.md 第10章 Phase 7-8 / CLAUDE.md「Desktop 機能を足す」。
//
// 公開コマンド:
//  * `write_pack_folder` — VirtualPack を root フォルダ直下に展開（既存内容は削除して上書き）
//  * `write_file`        — 任意パスに 1 ファイルを書き出す（.zip エクスポート用）
//  * `read_pack_zip`     — 任意の .zip パスを丸ごとバイト列で返す
//  * `read_pack_folder`  — 任意のフォルダを再帰 walk し、相対パス → バイト列の map を返す
//  * `binary_put` / `binary_get` / `binary_delete` / `binary_keys`
//    — 永続化バイナリ（画像/音声）の実体ストア。appDataDir/binaries/<key> に置く
//      （フロントの `store/storage/desktop.ts` が使う。CLAUDE.md 第7.2章）
//
// 設計メモ:
//  * パストラバーサル（`..`）や絶対パスを VirtualPack のキーとして含めない（書込側で拒否）。
//  * シンボリックリンクは追わない（無視）。
//  * Zip 生成・展開は JS 側（JSZip）で行う。Rust に zip クレートを足さない。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// VirtualPack を `<root>/` 直下に展開する（root 自体がパックフォルダ）。
///
/// 引数:
///  - `root`  : パックの root 絶対パス。同名フォルダがあれば**内容ごと削除して上書き**する。
///              親フォルダは事前に存在している前提（無ければエラー）。
///  - `files` : VirtualPack。キーはパック内相対パス（POSIX 区切り）、値はバイト列。
///
/// 「名前を付けて保存」と「上書き保存」の両方で本コマンドを使う。命名は呼び出し側
/// （フロント）の責務で、Rust 側は受け取った root をそのまま使う。
///
/// 返り値: 書き出した root の絶対パス（toast 表示用）。
#[tauri::command]
fn write_pack_folder(
    root: String,
    files: HashMap<String, Vec<u8>>,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);

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
        fs::remove_dir_all(&root_path).map_err(|e| {
            format!("既存フォルダ削除に失敗 {}: {e}", root_path.display())
        })?;
    }
    fs::create_dir_all(&root_path)
        .map_err(|e| format!("フォルダ作成に失敗 {}: {e}", root_path.display()))?;

    for (rel_path, bytes) in files.iter() {
        // パストラバーサル防止: 区切りを `/` `\` 双方で見て `..` セグメントを禁止。
        if rel_path
            .split(|c| c == '/' || c == '\\')
            .any(|seg| seg == ".." || seg.is_empty())
        {
            return Err(format!(
                "不正なパス（\"..\" もしくは空セグメント）: {rel_path}"
            ));
        }
        let p = Path::new(rel_path);
        if p.is_absolute() {
            return Err(format!("不正なパス（絶対パス）: {rel_path}"));
        }

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
#[tauri::command]
fn write_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "出力先の親フォルダが存在しません: {}",
                parent.display()
            ));
        }
    }
    fs::write(&p, &bytes)
        .map_err(|e| format!("書き込みに失敗 {}: {e}", p.display()))?;
    Ok(p.to_string_lossy().to_string())
}

/// 任意の .zip ファイルを丸ごとバイナリで返す。
/// Zip 展開は JS 側（`zipFileToVirtualPack`）で行う。
#[tauri::command]
fn read_pack_zip(path: String) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("ファイルが存在しません: {}", p.display()));
    }
    fs::read(&p).map_err(|e| format!("読み込み失敗 {}: {e}", p.display()))
}

/// 指定フォルダを再帰 walk し、相対パス → バイナリの map を返す。
/// 相対パスは POSIX 区切り（`/`）に揃える（VirtualPack 規約）。
/// シンボリックリンクは追わない（metadata.is_file/is_dir 判定で除外される）。
#[tauri::command]
fn read_pack_folder(path: String) -> Result<HashMap<String, Vec<u8>>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("フォルダが存在しません: {}", root.display()));
    }
    let mut out: HashMap<String, Vec<u8>> = HashMap::new();
    walk_dir(&root, &root, &mut out)?;
    Ok(out)
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

#[tauri::command]
fn binary_put(app: tauri::AppHandle, key: String, bytes: Vec<u8>) -> Result<(), String> {
    validate_binary_key(&key)?;
    let path = binaries_dir(&app)?.join(&key);
    fs::write(&path, &bytes)
        .map_err(|e| format!("バイナリ書き込みに失敗 {}: {e}", path.display()))
}

#[tauri::command]
fn binary_get(app: tauri::AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    validate_binary_key(&key)?;
    let path = binaries_dir(&app)?.join(&key);
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(&path)
        .map(Some)
        .map_err(|e| format!("バイナリ読み込みに失敗 {}: {e}", path.display()))
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
            binary_put,
            binary_get,
            binary_delete,
            binary_keys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
