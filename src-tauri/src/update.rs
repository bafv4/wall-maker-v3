// 更新通知＋リリースアセットのダウンロード＋Windows ポータブル版のワンクリック更新。
//
// 方針（CLAUDE.md「デスクトップ機能を足す」の更新ポリシー）:
//  * GitHub Releases の最新版をチェックして通知する。バックグラウンドでの自動適用はしない。
//  * **Windows ポータブル版（リリースビルド）だけ**、ユーザーが押したときに exe を
//    差し替えて再起動する（{@link update_apply_portable} / {@link update_relaunch}）。
//    ダウンロードは GitHub が公開するアセットの SHA-256（API の `digest`）とサイズで
//    検証し、一致しなければ差し替えない。
//  * それ以外（インストーラ導入・macOS）は、ユーザーが押したときだけ**現在の実行ファイルと
//    同じフォルダ**へ該当アセットをダウンロードする（適用＝インストーラ実行等はユーザー自身）。
//  * 配布形態に合わせたアセットを選ぶ。ポータブル版で使用中ならポータブル版を、
//    インストーラ導入なら NSIS setup（無ければ MSI）を選ぶ。判定はアンインストーラの
//    有無と実行ファイルの場所で行い、**判別できないときはポータブル版に倒す**
//    （ポータブル exe はリネームされ得るため、ファイル名には依存しない）。
//  * ダウンロード先が書き込み不可（Program Files 等）の場合は OS のダウンロード
//    フォルダへフォールバックし、実際の保存先を返す。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    /// GitHub が計算したアセットのハッシュ（"sha256:<hex>"）。古いリリースには無い。
    digest: Option<String>,
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
    /// 実行中のバージョン（tauri.conf.json の `version`）
    current_version: String,
    /// リリースページ URL
    release_url: String,
    /// この配布形態に合うアセット。見つからなければ None（リリースページへ誘導）
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size: Option<u64>,
    /// ワンクリック更新（{@link update_apply_portable}）が使えるか
    can_auto_apply: bool,
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

async fn fetch_latest_release() -> Result<GhRelease, String> {
    github_client()?
        .get(UPDATE_REPO_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("更新チェックのリクエストに失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("更新チェックが HTTP エラー: {e}"))?
        .json()
        .await
        .map_err(|e| format!("更新チェックの応答を解釈できません: {e}"))
}

/// `digest` が "sha256:<64 桁 hex>" ならその hex（小文字）を返す。
fn expected_sha256(asset: &GhReleaseAsset) -> Option<String> {
    let hex = asset.digest.as_deref()?.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// ワンクリック更新の対象か。Windows のポータブル版リリースビルドで、検証用の
/// SHA-256 が取れるアセットがあるときだけ。debug ビルド（`tauri dev`）は
/// target/debug の exe を差し替えてしまうので対象外。
fn can_auto_apply(kind: InstallKind, asset: Option<&GhReleaseAsset>) -> bool {
    cfg!(target_os = "windows")
        && !cfg!(debug_assertions)
        && matches!(kind, InstallKind::Portable)
        && asset.is_some_and(|a| {
            a.browser_download_url.starts_with(UPDATE_DOWNLOAD_PREFIX)
                && expected_sha256(a).is_some()
        })
}

/// 最新リリースを調べ、現在より新しければ配布形態に合うアセット情報を返す。
/// 新しくなければ Ok(None)。ネットワーク失敗はエラー（フロントは黙って握る）。
/// 現在のバージョンはフロントから受けず `package_info` を使う（適用側と判定を揃える）。
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current_version = app.package_info().version.to_string();
    let release = fetch_latest_release().await?;

    if !is_newer_version(&release.tag_name, &current_version) {
        return Ok(None);
    }
    let kind = detect_install_kind();
    let asset = pick_asset(&release.assets, kind);
    Ok(Some(UpdateInfo {
        version: release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name)
            .to_string(),
        current_version,
        release_url: release.html_url,
        asset_name: asset.map(|a| a.name.clone()),
        asset_url: asset.map(|a| a.browser_download_url.clone()),
        asset_size: asset.map(|a| a.size),
        can_auto_apply: can_auto_apply(kind, asset),
    }))
}

/// 一時ファイルの後始末。スコープを抜けるとき（エラーでの早期 return を含む）に消す。
/// 確定（rename）に成功した後は元のパスが無いので、削除は空振りする。
/// Windows は開いたままのファイルを消せないので、File を先に閉じてから drop させること。
struct RemoveOnDrop<'a>(&'a Path);

impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0);
    }
}

/// リリースアセットの GET を開始する（HTTP エラーのステータスもここで弾く）。
async fn start_download(url: &str) -> Result<reqwest::Response, String> {
    github_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("ダウンロードが HTTP エラー: {e}"))
}

/// レスポンス本体を `file` へ流し込み、受信バイト数を返す。各チャンクは `on_chunk`
/// にも渡す（ハッシュ計算用）。失敗時の一時ファイル削除は呼び出し側（RemoveOnDrop）の責務。
async fn stream_download(
    resp: &mut reqwest::Response,
    file: &mut fs::File,
    part: &Path,
    on_progress: &tauri::ipc::Channel<DownloadProgress>,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<u64, String> {
    let total = resp.content_length();
    // チャンクは TLS レコード単位（8〜16KB）で届くため、素の File だと 100MB 級の
    // アセットで数千〜万回の write システムコールになる。1MB バッファでまとめる。
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(bytes) = resp
        .chunk()
        .await
        .map_err(|e| format!("ダウンロード中に切断されました: {e}"))?
    {
        writer
            .write_all(&bytes)
            .map_err(|e| format!("書き込みに失敗 {}: {e}", part.display()))?;
        on_chunk(&bytes);
        received += bytes.len() as u64;
        // 進捗はチャンクごとに送ると IPC が煩すぎるので 512KB ごと
        if received - last_emit >= 512 * 1024 {
            last_emit = received;
            let _ = on_progress.send(DownloadProgress { received, total });
        }
    }
    writer
        .flush()
        .map_err(|e| format!("書き込みに失敗 {}: {e}", part.display()))?;
    let _ = on_progress.send(DownloadProgress { received, total });
    Ok(received)
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

    let mut resp = start_download(&url).await?;

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
    let _cleanup = RemoveOnDrop(&part);

    let streamed = stream_download(&mut resp, &mut file, &part, &on_progress, |_| {}).await;
    drop(file);
    streamed?;

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

/// 適用中/適用済みなら true（二重実行と、差し替え後の再適用を防ぐ）。
static APPLYING: AtomicBool = AtomicBool::new(false);
/// 差し替え後に起動する exe（= 差し替え前の元パス）。update_relaunch が使う。
/// 実行中 exe はリネーム後に `current_exe()` が退避先を指しうるので、ここに控える。
static RELAUNCH_TARGET: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 差し替えで退避した旧 exe（`<exe 名>.old`）。起動時に削除する。
fn replaced_exe_path(exe: &Path) -> Option<PathBuf> {
    let name = exe.file_name()?.to_string_lossy().into_owned();
    Some(exe.with_file_name(format!("{name}.old")))
}

/// Windows ポータブル版のワンクリック更新（ダウンロード＋差し替えまで。再起動は
/// {@link update_relaunch}）。
///
/// フロントからは URL を受けず、最新リリースをここで取り直して判定する
/// （webview から任意の exe を書き込ませないため）。手順:
///  1. `<exe 名>.update.part` へダウンロードしつつ SHA-256 を計算
///  2. サイズと GitHub の `digest` を照合。不一致なら破棄してエラー
///  3. 実行中 exe を `<exe 名>.old` へリネーム（Windows は実行中ファイルの上書きは
///     できないがリネームはできる）→ 新 exe を元の名前へ。失敗したら巻き戻す
/// ユーザーが exe をリネームしていても、その名前のまま差し替わる。
#[tauri::command]
pub async fn update_apply_portable(
    app: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    if APPLYING.swap(true, Ordering::SeqCst) {
        return Err("更新はすでに適用中か適用済みです".into());
    }
    let result = apply_portable(&app, &on_progress).await;
    if result.is_err() {
        APPLYING.store(false, Ordering::SeqCst);
    }
    result
}

async fn apply_portable(
    app: &tauri::AppHandle,
    on_progress: &tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    let release = fetch_latest_release().await?;
    if !is_newer_version(&release.tag_name, &app.package_info().version.to_string()) {
        return Err("新しいバージョンはありません".into());
    }
    let kind = detect_install_kind();
    let asset = pick_asset(&release.assets, kind)
        .filter(|a| can_auto_apply(kind, Some(a)))
        .ok_or("この環境ではワンクリック更新を使えません（Windows ポータブル版のみ）")?;
    let expected = expected_sha256(asset).ok_or("アセットのハッシュがありません")?;

    let exe = std::env::current_exe().map_err(|e| format!("実行パス取得に失敗: {e}"))?;
    let old = replaced_exe_path(&exe).ok_or("実行ファイル名を取得できません")?;
    let part = old.with_extension("update.part");

    let mut resp = start_download(&asset.browser_download_url).await?;
    let mut file = fs::File::create(&part)
        .map_err(|e| format!("一時ファイル作成に失敗 {}: {e}", part.display()))?;
    // 検証失敗・差し替え失敗のどちらでも .part を残さない（差し替え成功後は空振り）
    let _cleanup = RemoveOnDrop(&part);
    let mut hasher = Sha256::new();
    let streamed = stream_download(&mut resp, &mut file, &part, on_progress, |b| {
        hasher.update(b)
    })
    .await;
    // 実行ファイルとして置き換えるので、こちらは確定前にディスクへ書き切る
    let synced = streamed.and_then(|n| {
        file.sync_all()
            .map(|_| n)
            .map_err(|e| format!("書き込みに失敗 {}: {e}", part.display()))
    });
    drop(file);
    let received = synced?;
    let actual = to_hex(&hasher.finalize());
    if received != asset.size || actual != expected {
        return Err(format!(
            "ダウンロードしたファイルの検証に失敗しました（サイズ {received}/{} / SHA-256 {}）",
            asset.size,
            if actual == expected { "一致" } else { "不一致" }
        ));
    }

    swap_exe(&exe, &part, &old)?;
    *RELAUNCH_TARGET
        .lock()
        .map_err(|_| "内部状態の取得に失敗しました")? = Some(exe);
    Ok(())
}

/// `exe` を `old` へ退避し、`new_exe` を `exe` の位置へ置く。失敗したら元に戻す。
/// 失敗時に残った `new_exe` の削除は呼び出し側（RemoveOnDrop）に任せる。
fn swap_exe(exe: &Path, new_exe: &Path, old: &Path) -> Result<(), String> {
    // 前回更新の残骸（起動時の削除が間に合わなかった等）
    if old.exists() {
        fs::remove_file(old)
            .map_err(|e| format!("前回の更新ファイルを削除できません {}: {e}", old.display()))?;
    }
    fs::rename(exe, old)
        .map_err(|e| format!("実行中ファイルの退避に失敗 {}: {e}", exe.display()))?;
    if let Err(e) = fs::rename(new_exe, exe) {
        let _ = fs::rename(old, exe);
        return Err(format!("新しい実行ファイルの配置に失敗 {}: {e}", exe.display()));
    }
    Ok(())
}

/// 差し替えた exe を起動してこのプロセスを終了する。フロントは呼ぶ前に永続化を
/// 書き切っておくこと（終了で保留中の書き込みが失われる）。
#[tauri::command]
pub fn update_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    let target = RELAUNCH_TARGET
        .lock()
        .map_err(|_| "内部状態の取得に失敗しました")?
        .clone()
        .ok_or("適用済みの更新がありません")?;
    let mut cmd = std::process::Command::new(&target);
    if let Some(dir) = target.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map_err(|e| format!("新しいバージョンの起動に失敗: {e}"))?;
    app.exit(0);
    Ok(())
}

/// 起動時の後片付け: 差し替えで退避した旧 exe と、中断した `.update.part` を消す。
/// 旧プロセスの終了直後は旧 exe がまだロックされていることがあるので、別スレッドで
/// 少し待ちながら再試行する（起動は待たせない）。
pub fn cleanup_replaced_exe() {
    if !cfg!(target_os = "windows") {
        return;
    }
    let Some(old) = std::env::current_exe()
        .ok()
        .and_then(|exe| replaced_exe_path(&exe))
    else {
        return;
    };
    let _ = fs::remove_file(old.with_extension("update.part"));
    if !old.exists() {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..20 {
            if fs::remove_file(&old).is_ok() || !old.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
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
            digest: None,
        }
    }

    #[test]
    fn digest_parse() {
        let mut a = asset("x.exe");
        assert_eq!(expected_sha256(&a), None);
        let hex = "5FA71685".repeat(8);
        a.digest = Some(format!("sha256:{hex}"));
        assert_eq!(expected_sha256(&a), Some(hex.to_ascii_lowercase()));
        a.digest = Some(format!("sha512:{hex}"));
        assert_eq!(expected_sha256(&a), None);
        a.digest = Some("sha256:abc".into());
        assert_eq!(expected_sha256(&a), None);
        assert_eq!(to_hex(&[0x00, 0xab, 0x0f]), "00ab0f");
    }

    #[test]
    fn swap_exe_replaces_and_keeps_old() {
        let dir = std::env::temp_dir().join(format!("wm-swap-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("app.exe");
        let old = replaced_exe_path(&exe).unwrap();
        let part = old.with_extension("update.part");
        assert_eq!(old.file_name().unwrap(), "app.exe.old");
        assert_eq!(part.file_name().unwrap(), "app.exe.update.part");

        fs::write(&exe, b"v1").unwrap();
        fs::write(&old, b"stale").unwrap(); // 前回の残骸は消して置き換える
        fs::write(&part, b"v2").unwrap();
        swap_exe(&exe, &part, &old).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"v2");
        assert_eq!(fs::read(&old).unwrap(), b"v1");
        assert!(!part.exists());
        fs::remove_dir_all(&dir).unwrap();
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
