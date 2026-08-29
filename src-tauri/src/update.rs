// 更新通知＋リリースアセットのダウンロード。
//
// 方針（CLAUDE.md「自動更新なし」の範囲内）:
//  * インストールの自動適用はしない。GitHub Releases の最新版をチェックして通知し、
//    ユーザーが押したときだけ、**現在の実行ファイルと同じフォルダ**へ該当アセットを
//    ダウンロードする（適用＝インストーラ実行や差し替えはユーザー自身が行う）。
//  * 配布形態に合わせたアセットを選ぶ。ポータブル版で使用中ならポータブル版を、
//    インストーラ導入なら NSIS setup（無ければ MSI）を選ぶ。判定はアンインストーラの
//    有無と実行ファイルの場所で行い、**判別できないときはポータブル版に倒す**
//    （ポータブル exe はリネームされ得るため、ファイル名には依存しない）。
//  * ダウンロード先が書き込み不可（Program Files 等）の場合は OS のダウンロード
//    フォルダへフォールバックし、実際の保存先を返す。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 更新チェック対象のリポジトリ（このアプリ自身）。
const UPDATE_REPO_API: &str =
    "https://api.github.com/repos/bafv4/wall-maker-v3/releases/latest";
/// ダウンロードを許可する URL の接頭辞。これ以外への fetch はコマンド側で拒否する
/// （webview から任意 URL のダウンロードに悪用されないための最終防衛線）。
const UPDATE_DOWNLOAD_PREFIX: &str =
    "https://github.com/bafv4/wall-maker-v3/releases/download/";

#[derive(Deserialize)]
struct GhReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GhReleaseAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版のバージョン（先頭 v なし。例 "3.3.0"）
    version: String,
    /// リリースページ URL
    release_url: String,
    /// この配布形態に合うアセット。見つからなければ None（リリースページへ誘導）
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: u64,
    /// Content-Length が無いと None
    total: Option<u64>,
}

/// "v3.2.0" / "3.2.0" → (3,2,0)。3 要素の数値でなければ None（プレリリース等は比較しない）。
fn parse_semver_triple(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut it = s.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_newer_version(latest_tag: &str, current: &str) -> bool {
    match (parse_semver_triple(latest_tag), parse_semver_triple(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// この実行環境の配布形態。
#[derive(Clone, Copy)]
enum InstallKind {
    /// ポータブル（単一 exe / 展開した .app）。判別不能時の既定でもある。
    Portable,
    /// インストーラ導入（Windows: NSIS/MSI、macOS: /Applications 配下）
    Installed,
}

#[cfg(target_os = "windows")]
fn detect_install_kind() -> InstallKind {
    let Ok(exe) = std::env::current_exe() else {
        return InstallKind::Portable;
    };
    // Tauri の NSIS インストーラは同じフォルダに uninstall.exe を置く
    if exe
        .parent()
        .is_some_and(|dir| dir.join("uninstall.exe").is_file())
    {
        return InstallKind::Installed;
    }
    if exe
        .to_string_lossy()
        .to_ascii_lowercase()
        .contains("\\program files")
    {
        return InstallKind::Installed; // MSI（per-machine）
    }
    InstallKind::Portable
}

#[cfg(target_os = "macos")]
fn detect_install_kind() -> InstallKind {
    match std::env::current_exe() {
        Ok(exe) if exe.to_string_lossy().starts_with("/Applications/") => {
            InstallKind::Installed
        }
        _ => InstallKind::Portable,
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_install_kind() -> InstallKind {
    InstallKind::Portable
}

fn find_asset(
    assets: &[GhReleaseAsset],
    pred: impl Fn(&str) -> bool,
) -> Option<&GhReleaseAsset> {
    assets.iter().find(|a| pred(&a.name.to_ascii_lowercase()))
}

/// 配布形態に合うアセットをリリースのアセット一覧から選ぶ。
/// アセット命名は release.yml が生成する実物に合わせる（v3.2.0 で確認。
/// release.yml 側にも「この名前を変えると更新通知が壊れる」旨を注記してある）:
///   Wall.Maker_3.2.0_x64-setup.exe / Wall.Maker_3.2.0_x64_en-US.msi /
///   WallMaker-v3.2.0-portable-windows-x64.exe /
///   Wall.Maker_3.2.0_universal.dmg / WallMaker-v3.2.0-portable-macos-universal.zip
#[cfg(target_os = "windows")]
fn pick_asset(assets: &[GhReleaseAsset], kind: InstallKind) -> Option<&GhReleaseAsset> {
    match kind {
        InstallKind::Portable => find_asset(assets, |n| n.contains("portable-windows")),
        InstallKind::Installed => find_asset(assets, |n| n.ends_with("-setup.exe"))
            .or_else(|| find_asset(assets, |n| n.ends_with(".msi"))),
    }
}

#[cfg(target_os = "macos")]
fn pick_asset(assets: &[GhReleaseAsset], kind: InstallKind) -> Option<&GhReleaseAsset> {
    match kind {
        InstallKind::Portable => find_asset(assets, |n| n.contains("portable-macos")),
        InstallKind::Installed => find_asset(assets, |n| n.ends_with(".dmg")),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn pick_asset(_assets: &[GhReleaseAsset], _kind: InstallKind) -> Option<&GhReleaseAsset> {
    None
}

/// ダウンロード先フォルダ = 実行ファイルと同じフォルダ。
/// macOS の .app バンドル内（Contents/MacOS）で動いている場合は、ファイルが
/// バンドルの中に埋もれないよう .app を**含む**フォルダまで上がる。
fn update_dest_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("実行パス取得に失敗: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("実行ファイルの親フォルダがありません")?
        .to_path_buf();
    #[cfg(target_os = "macos")]
    {
        let mut cur = dir.clone();
        loop {
            if cur.extension().map(|e| e == "app").unwrap_or(false) {
                if let Some(p) = cur.parent() {
                    return Ok(p.to_path_buf());
                }
                break;
            }
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => break,
            }
        }
    }
    Ok(dir)
}

/// 共有 HTTP クライアント。TLS 設定（webpki ルート証明書のパース）とコネクション
/// プールを update_check / update_download で使い回す（Client の clone は Arc の複製）。
fn github_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        // GitHub API は User-Agent 必須（無いと 403）
        .user_agent(concat!("wall-maker-v3/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60 * 10))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP クライアント初期化に失敗: {e}"))?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// 最新リリースを調べ、現在より新しければ配布形態に合うアセット情報を返す。
/// 新しくなければ Ok(None)。ネットワーク失敗はエラー（フロントは黙って握る）。
#[tauri::command]
pub async fn update_check(current_version: String) -> Result<Option<UpdateInfo>, String> {
    let client = github_client()?;
    let release: GhRelease = client
        .get(UPDATE_REPO_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("更新チェックのリクエストに失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("更新チェックが HTTP エラー: {e}"))?
        .json()
        .await
        .map_err(|e| format!("更新チェックの応答を解釈できません: {e}"))?;

    if !is_newer_version(&release.tag_name, &current_version) {
        return Ok(None);
    }
    let asset = pick_asset(&release.assets, detect_install_kind());
    Ok(Some(UpdateInfo {
        version: release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name)
            .to_string(),
        release_url: release.html_url,
        asset_name: asset.map(|a| a.name.clone()),
        asset_url: asset.map(|a| a.browser_download_url.clone()),
        asset_size: asset.map(|a| a.size),
    }))
}

/// リリースアセットを実行ファイルと同じフォルダへダウンロードする。
/// 書き込めない場合（Program Files 等）は OS のダウンロードフォルダへ。
/// `.part` に書いてから rename するので、中断で壊れたファイルが残らない。
/// 戻り値は保存した絶対パス。
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<String, String> {
    if !url.starts_with(UPDATE_DOWNLOAD_PREFIX) {
        return Err("このリポジトリのリリース以外からはダウンロードできません".into());
    }
    // アセット名は単一のファイル名として検証する（区切り文字・`..`・Windows のドライブ
    // 記号を拒否）。lib.rs の validate_binary_key（UUID 用）や write_pack_folder の
    // 相対パス検証（複数セグメント用）とは対象の形が違うため、ここで独立に持つ。
    if file_name.is_empty()
        || file_name.chars().any(|c| c == '/' || c == '\\' || c == ':')
        || file_name.contains("..")
    {
        return Err(format!("不正なファイル名: {file_name}"));
    }

    let client = github_client()?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("ダウンロードが HTTP エラー: {e}"))?;
    let total = resp.content_length();

    // 保存先: 実行ファイルと同じフォルダ。`.part` の作成自体が書き込み可否の判定を
    // 兼ねる（失敗したら OS のダウンロードフォルダで作り直す）。
    let mut dir = update_dest_dir()?;
    let mut file = match fs::File::create(dir.join(format!("{file_name}.part"))) {
        Ok(f) => f,
        Err(_) => {
            dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("ダウンロードフォルダの取得に失敗: {e}"))?;
            let part = dir.join(format!("{file_name}.part"));
            fs::File::create(&part)
                .map_err(|e| format!("一時ファイル作成に失敗 {}: {e}", part.display()))?
        }
    };
    let part = dir.join(format!("{file_name}.part"));
    let final_path = dir.join(&file_name);

    // チャンクは TLS レコード単位（8〜16KB）で届くため、素の File だと 100MB 級の
    // アセットで数千〜万回の write システムコールになる。1MB バッファでまとめる。
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, &mut file);
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let chunk = resp.chunk().await.map_err(|e| {
            let _ = fs::remove_file(&part);
            format!("ダウンロード中に切断されました: {e}")
        })?;
        let Some(bytes) = chunk else { break };
        writer.write_all(&bytes).map_err(|e| {
            let _ = fs::remove_file(&part);
            format!("書き込みに失敗 {}: {e}", part.display())
        })?;
        received += bytes.len() as u64;
        // 進捗はチャンクごとに送ると IPC が煩すぎるので 512KB ごと
        if received - last_emit >= 512 * 1024 {
            last_emit = received;
            let _ = on_progress.send(DownloadProgress { received, total });
        }
    }
    writer.flush().map_err(|e| {
        let _ = fs::remove_file(&part);
        format!("書き込みに失敗 {}: {e}", part.display())
    })?;
    drop(writer);
    drop(file);
    let _ = on_progress.send(DownloadProgress { received, total });

    // 同名ファイルがあれば上書き（同じバージョンの再ダウンロード）。
    // fsync はしない: 中断は `.part` のままなので壊れたファイルが完成品に見える
    // ことはなく、再ダウンロード可能な成果物に耐久性保証は不要。
    if final_path.exists() {
        fs::remove_file(&final_path)
            .map_err(|e| format!("既存ファイルの置換に失敗 {}: {e}", final_path.display()))?;
    }
    fs::rename(&part, &final_path)
        .map_err(|e| format!("ファイルの確定に失敗 {}: {e}", final_path.display()))?;
    Ok(final_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(is_newer_version("v3.3.0", "3.2.0"));
        assert!(is_newer_version("3.10.0", "3.9.9"));
        assert!(!is_newer_version("v3.2.0", "3.2.0"));
        assert!(!is_newer_version("v3.1.9", "3.2.0"));
        // プレリリースや不正な形式は「新しくない」扱い（通知しない）
        assert!(!is_newer_version("v3.3.0-beta.1", "3.2.0"));
        assert!(!is_newer_version("garbage", "3.2.0"));
        assert!(!is_newer_version("v3.3.0", "garbage"));
    }

    fn asset(name: &str) -> GhReleaseAsset {
        GhReleaseAsset {
            name: name.into(),
            browser_download_url: format!("{UPDATE_DOWNLOAD_PREFIX}v9.9.9/{name}"),
            size: 1,
        }
    }

    #[test]
    fn asset_pick_matches_distribution() {
        let assets = vec![
            asset("Wall.Maker_3.3.0_universal.dmg"),
            asset("Wall.Maker_3.3.0_x64-setup.exe"),
            asset("Wall.Maker_3.3.0_x64_en-US.msi"),
            asset("WallMaker-v3.3.0-portable-macos-universal.zip"),
            asset("WallMaker-v3.3.0-portable-windows-x64.exe"),
        ];
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                pick_asset(&assets, InstallKind::Portable).unwrap().name,
                "WallMaker-v3.3.0-portable-windows-x64.exe"
            );
            assert_eq!(
                pick_asset(&assets, InstallKind::Installed).unwrap().name,
                "Wall.Maker_3.3.0_x64-setup.exe"
            );
            // NSIS setup が無いリリースでは MSI に倒れる
            let no_nsis: Vec<_> = assets
                .iter()
                .filter(|a| !a.name.ends_with("-setup.exe"))
                .map(|a| asset(&a.name))
                .collect();
            assert_eq!(
                pick_asset(&no_nsis, InstallKind::Installed).unwrap().name,
                "Wall.Maker_3.3.0_x64_en-US.msi"
            );
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                pick_asset(&assets, InstallKind::Portable).unwrap().name,
                "WallMaker-v3.3.0-portable-macos-universal.zip"
            );
            assert_eq!(
                pick_asset(&assets, InstallKind::Installed).unwrap().name,
                "Wall.Maker_3.3.0_universal.dmg"
            );
        }
    }
}
