/**
 * useFileOperations — ファイル操作（Import / Save / Export / Reset）の状態とハンドラを集約する Provider+hook。
 *
 * 目的:
 *  - AppHeader（Web）と FileEditor タブ（Desktop）の両方から同じ Import 進行状態を
 *    共有するため、状態を一段上に巻き上げる。
 *  - 非表示の `<input type="file">` と `<ImportResolutionDialog />` を Provider 直下に
 *    1 箇所だけマウントし、タブ切替で消えないようにする。
 *
 * Import の入口:
 *  - `openImport`        : Web — `<input type="file">` を開く
 *  - `openZipImport`     : Desktop — Tauri dialog で .zip を選ばせる
 *  - `openFolderImport`  : Desktop — Tauri dialog でフォルダを選ばせる
 *
 * 書き出し（Desktop 仕様 — 2026-06-12 改定）:
 *  - `doExportZip`       : Web=download / Desktop=.zip 保存ダイアログ
 *  - `doSaveAsFolder`    : Desktop のみ — 親フォルダ選択 → `<parent>/<packName>/`
 *  - `doSaveOverwrite`   : Desktop のみ — 既知 `sourceFolder` を上書き保存
 *  - `canOverwrite`      : 上書き保存ボタンの活性条件（`sourceFolder != null`）
 *  - `sourceFolder`      : 「フォルダから開いた／フォルダで保存した」 root
 *
 * `sourceFolder` の永続化（Desktop のみ）:
 *  - パス文字列だけを `tauri-plugin-store` に記憶し、次回起動時に復元する
 *    （CLAUDE.md「出力先はユーザに選ばせて `tauri-plugin-store` に記憶する」）。
 *  - 復元時は実在検証（Rust `path_is_dir`）を通す。消えていたら記憶ごと捨てる。
 *  - 復元した保存先への**初回の上書き保存だけ確認ダイアログを挟む**。編集内容の復元に
 *    失敗して既定 state で起動した場合でも保存先は復元されうるため、無確認だと
 *    `write_pack_folder`（root ごと削除して書き直す）がユーザのパックを消してしまう。
 *  - 実体は `adapters/desktopSaveTarget.ts`。Web では全て no-op。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  forgetSaveTarget,
  isTauri,
  loadSaveTarget,
  readPack,
  rememberSaveTarget,
  saveZipBytes,
} from '../adapters';
import { ImportResolutionDialog } from '../components/ImportResolutionDialog';
import { ConfirmDialog, toast } from '../components/ui';
import { errMsg } from '../core/errors';
import {
  buildAndZipInWorker,
  buildPackInWorker,
} from '../core/exportWorkerClient';
import { detectBackgroundResolution, parsePack } from '../core/parsePack';
import type { Resolution } from '../core/state';
import type { PackReadSource, VirtualPack } from '../core/types';
import { useWallStore } from '../store/useWallStore';

interface ImportPayload {
  displayName: string;
  pack: VirtualPack;
  suggested: Resolution | null;
  /** フォルダから開いた場合の root。それ以外は null。 */
  sourceFolder: string | null;
}

type ImportState =
  | { kind: 'idle' }
  | { kind: 'loading-zip'; displayName: string }
  | { kind: 'pick-resolution'; payload: ImportPayload }
  | { kind: 'parsing'; payload: ImportPayload };

export interface FileOperationsContextValue {
  busy: boolean;
  importPhase: ImportState['kind'];

  /** Web: hidden `<input type="file">` を開く */
  openImport: () => void;
  /** Desktop: Tauri dialog で .zip を選ばせて読込開始 */
  openZipImport: () => Promise<void>;
  /** Desktop: Tauri dialog でフォルダを選ばせて読込開始 */
  openFolderImport: () => Promise<void>;

  /** Web=zip ダウンロード / Desktop=.zip 保存ダイアログ */
  doExportZip: () => Promise<void>;
  /** Desktop: 親フォルダ選択 → `<parent>/<packName>/` に書き出し（名前を付けて保存） */
  doSaveAsFolder: () => Promise<void>;
  /** Desktop: `sourceFolder` を上書き保存（ボタン側で canOverwrite を見ること） */
  doSaveOverwrite: () => Promise<void>;
  /** 上書き保存が有効か（フォルダ起点で開いた／保存した直後のみ true） */
  canOverwrite: boolean;
  /** 現在編集中のパックが紐づくフォルダ root（無ければ null） */
  sourceFolder: string | null;

  doReset: () => void;
}

const FileOperationsContext = createContext<FileOperationsContextValue | null>(
  null,
);

export function useFileOperations(): FileOperationsContextValue {
  const ctx = useContext(FileOperationsContext);
  if (!ctx)
    throw new Error(
      'useFileOperations must be used inside <FileOperationsProvider>',
    );
  return ctx;
}

/** OS パス（Win/Posix どちらでも）から末尾セグメントを取り出す。 */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function FileOperationsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const desktop = isTauri();

  const packName = useWallStore((s) => s.wall.packInfo.name);
  const currentResolution = useWallStore((s) => s.wall.resolution);
  const reset = useWallStore((s) => s.reset);
  const replaceWallState = useWallStore((s) => s.replaceWallState);
  const selectBackgroundLayer = useWallStore((s) => s.selectBackgroundLayer);

  const [busy, setBusy] = useState(false);
  const [importState, setImportState] = useState<ImportState>({ kind: 'idle' });
  const [sourceFolder, setSourceFolderState] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [confirmRestoredOpen, setConfirmRestoredOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 保存先が「前回セッションからの復元」で、まだユーザの確認を得ていない状態か。
  // 上書き保存は Rust 側で root ごと削除して書き直すため、編集内容の復元に失敗して
  // 既定 state で起動したケースでは、無確認だとユーザのパックを消してしまう。
  // 初回の上書きだけ確認を挟み、以降はこのセッション中もう聞かない。
  const [restoredUnconfirmed, setRestoredUnconfirmed] = useState(false);

  // 起動時の非同期復元が、復元完了前のユーザ操作（インポート／保存／リセット）を
  // あとから上書きしないようにするためのガード。
  const saveTargetDecidedRef = useRef(false);

  /**
   * 保存先を更新する唯一の入口。React state と永続化（Desktop）を必ず揃える。
   * 永続化失敗はセッション内の動作を妨げないが、黙って古い保存先が残り続けると
   * 次回起動で誤った上書き先が復元されるため、非ブロッキング通知は出す。
   */
  const setSourceFolder = useCallback(
    (path: string | null) => {
      saveTargetDecidedRef.current = true;
      setSourceFolderState(path);
      // このセッションでユーザが明示的に決めた保存先なので、確認は不要。
      setRestoredUnconfirmed(false);
      const task = path == null ? forgetSaveTarget() : rememberSaveTarget(path);
      void task.catch((e: unknown) => {
        console.error('save target persist failed', e);
        toast.error(t('toast.saveTargetPersistFailed'));
      });
    },
    [t],
  );

  // 前回セッションの保存先を復元する（Desktop のみ。実在検証は adapter 側）。
  useEffect(() => {
    if (!desktop) return;
    let canceled = false;
    void loadSaveTarget()
      .then((result) => {
        if (canceled || saveTargetDecidedRef.current) return;
        if (result.kind === 'missing') {
          // 記憶はあったが実体が消えている。記憶は adapter が破棄済みなので何もしない。
          console.warn('remembered save target no longer exists', result.path);
          return;
        }
        if (result.kind !== 'restored') return;
        setSourceFolderState(result.path);
        setRestoredUnconfirmed(true);
      })
      .catch((e: unknown) => {
        console.error('save target restore failed', e);
      });
    return () => {
      canceled = true;
    };
  }, [desktop]);

  // ---- Import 共通: source を受け取って読込→解像度推定→ダイアログ表示 ----
  const startImport = useCallback(
    async (source: PackReadSource, displayName: string) => {
      // 起動直後にインポートが始まった場合、あとから解決する保存先の復元が
      // このインポートに割り込まないようにする（確定は handleConfirmImport 側）。
      // 保存先そのものは readPack が返す rootPath から決める（選択パスは親の可能性がある）。
      saveTargetDecidedRef.current = true;
      setImportState({ kind: 'loading-zip', displayName });
      setBusy(true);
      try {
        // パックフォルダの親を選ばれた場合、読込側がルートを引き上げて実際のパックルートを
        // `rootPath` で返す。上書き保存は必ずこちらを対象にする（選択パスだと親ごと消える）。
        const { pack, rootPath } = await readPack(source);
        const suggested = await detectBackgroundResolution(pack);
        setImportState({
          kind: 'pick-resolution',
          payload: {
            // ルートが引き上げられたときはパック名も実フォルダ名に合わせる
            displayName: rootPath ? basename(rootPath) : displayName,
            pack,
            suggested,
            sourceFolder: rootPath,
          },
        });
      } catch (e) {
        console.error('read failed', e);
        toast.error(t('toast.readFailed', { error: errMsg(e) }));
        setImportState({ kind: 'idle' });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  // ---- Import: ダイアログ確定後 ----
  const handleConfirmImport = async (resolution: Resolution) => {
    if (importState.kind !== 'pick-resolution') return;
    const { payload } = importState;
    setImportState({ kind: 'parsing', payload });
    setBusy(true);
    try {
      const wall = await parsePack(payload.pack, { resolution });
      const stem = payload.displayName.replace(/\.zip$/i, '').trim();
      if (stem) wall.packInfo.name = stem;
      replaceWallState(wall);
      selectBackgroundLayer(null);
      setSourceFolder(payload.sourceFolder); // フォルダ起点なら覚える、.zip 起点なら null
      toast.success(t('toast.importSuccess', { filename: payload.displayName }));
      setImportState({ kind: 'idle' });
    } catch (e) {
      console.error('parsePack failed', e);
      toast.error(t('toast.importFailed', { error: errMsg(e) }));
      // ダイアログを閉じずに pick-resolution に戻す（再試行可能）
      setImportState({ kind: 'pick-resolution', payload });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelImport = () => setImportState({ kind: 'idle' });

  // ---- Import 入口 ----
  const openImport = () => importInputRef.current?.click();
  const handleWebFilePicked = (file: File) =>
    void startImport({ kind: 'webZip', file }, file.name);

  const openZipImport = async () => {
    if (!desktop) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({
        multiple: false,
        title: t('fileEditor.import.openZip'),
        filters: [{ name: 'Resource pack (.zip)', extensions: ['zip'] }],
      });
      if (typeof result !== 'string') return;
      await startImport({ kind: 'desktopZip', path: result }, basename(result));
    } catch (e) {
      console.error('open zip import failed', e);
      toast.error(t('toast.readFailed', { error: errMsg(e) }));
    }
  };

  const openFolderImport = async () => {
    if (!desktop) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({
        directory: true,
        multiple: false,
        title: t('fileEditor.import.openFolder'),
      });
      if (typeof result !== 'string') return;
      await startImport(
        { kind: 'desktopFolder', path: result },
        basename(result),
      );
    } catch (e) {
      console.error('open folder import failed', e);
      toast.error(t('toast.readFailed', { error: errMsg(e) }));
    }
  };

  // ---- 書き出し系 ----
  // buildPack + JSZip は Web Worker 内で実行する（`core/exportWorkerClient`）。
  // メインスレッドの描画は止まらず、大きなパックでも UI が固まらない。
  const doExportZip = async () => {
    setBusy(true);
    try {
      const wall = useWallStore.getState().wall;
      const zipBytes = await buildAndZipInWorker(wall);
      const dest = await saveZipBytes(zipBytes, packName);
      if (dest == null) return; // ユーザキャンセル
      toast.success(t('toast.exportSuccess', { dest }));
    } catch (e) {
      console.error('export failed', e);
      toast.error(t('toast.exportFailed', { error: errMsg(e) }));
    } finally {
      setBusy(false);
    }
  };

  const doSaveAsFolder = async () => {
    if (!desktop) return;
    setBusy(true);
    try {
      const wall = useWallStore.getState().wall;
      // フォルダ保存は zip 不要なので buildPack のみワーカで走らせる
      const pack = await buildPackInWorker(wall);
      const { saveAsFolder } = await import('../adapters/desktop');
      const dest = await saveAsFolder(pack, packName);
      if (dest == null) return; // ユーザキャンセル
      setSourceFolder(dest); // 以降の上書き保存はここを指す
      toast.success(t('toast.saveSuccess', { dest }));
    } catch (e) {
      console.error('save as folder failed', e);
      toast.error(t('toast.saveFailed', { error: errMsg(e) }));
    } finally {
      setBusy(false);
    }
  };

  const runOverwrite = async (root: string) => {
    setBusy(true);
    try {
      const wall = useWallStore.getState().wall;
      const pack = await buildPackInWorker(wall);
      const { overwriteFolder } = await import('../adapters/desktop');
      const dest = await overwriteFolder(pack, root);
      toast.success(t('toast.overwriteSuccess', { dest }));
    } catch (e) {
      console.error('overwrite failed', e);
      toast.error(t('toast.overwriteFailed', { error: errMsg(e) }));
    } finally {
      setBusy(false);
    }
  };

  const doSaveOverwrite = async () => {
    if (!desktop) return;
    if (!sourceFolder) {
      toast.error(t('toast.overwriteNoTarget'));
      return;
    }
    // 復元された保存先への初回上書きだけ確認を挟む（root ごと消して書き直すため）。
    if (restoredUnconfirmed) {
      setConfirmRestoredOpen(true);
      return;
    }
    await runOverwrite(sourceFolder);
  };

  const confirmRestoredOverwrite = () => {
    setConfirmRestoredOpen(false);
    setRestoredUnconfirmed(false);
    if (sourceFolder) void runOverwrite(sourceFolder);
  };

  // Reset は破壊的なので確認ダイアログを挟む（非ブロッキング。`window.confirm` は使わない）。
  const doReset = () => setConfirmResetOpen(true);
  const confirmReset = () => {
    reset();
    setSourceFolder(null);
    setConfirmResetOpen(false);
  };

  const dialogOpen =
    importState.kind === 'pick-resolution' || importState.kind === 'parsing';
  const dialogFileName = dialogOpen ? importState.payload.displayName : '';
  const dialogSuggested = dialogOpen ? importState.payload.suggested : null;

  const value: FileOperationsContextValue = {
    busy,
    importPhase: importState.kind,
    openImport,
    openZipImport,
    openFolderImport,
    doExportZip,
    doSaveAsFolder,
    doSaveOverwrite,
    canOverwrite: desktop && sourceFolder != null,
    sourceFolder,
    doReset,
  };

  return (
    <FileOperationsContext.Provider value={value}>
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleWebFilePicked(f);
          if (importInputRef.current) importInputRef.current.value = '';
        }}
      />
      {children}
      <ImportResolutionDialog
        // ダイアログのセッションごとに remount し、内部 state（preset / custom W/H）を
        // 初期値で再構成する。明示 useEffect リセットの代わり。
        key={dialogOpen ? dialogFileName : 'closed'}
        open={dialogOpen}
        fileName={dialogFileName}
        suggested={dialogSuggested}
        current={currentResolution}
        busy={importState.kind === 'parsing'}
        onCancel={handleCancelImport}
        onConfirm={handleConfirmImport}
      />
      <ConfirmDialog
        open={confirmRestoredOpen}
        title={t('fileEditor.save.restoredConfirm.title')}
        message={t('fileEditor.save.restoredConfirm.message', {
          path: sourceFolder ?? '',
        })}
        confirmLabel={t('fileEditor.save.overwrite')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmRestoredOverwrite}
        onCancel={() => setConfirmRestoredOpen(false)}
      />
      <ConfirmDialog
        open={confirmResetOpen}
        title={t('fileEditor.reset.title')}
        message={t('fileEditor.reset.confirm')}
        confirmLabel={t('fileEditor.reset.button')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmReset}
        onCancel={() => setConfirmResetOpen(false)}
      />
    </FileOperationsContext.Provider>
  );
}
