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
 *  - `sourceFolder`      : 「フォルダから開いた／フォルダで保存した」 root（メモリ内のみ）
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, readPack, saveZipBytes } from '../adapters';
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
  const [sourceFolder, setSourceFolder] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ---- Import 共通: source を受け取って読込→解像度推定→ダイアログ表示 ----
  const startImport = useCallback(
    async (source: PackReadSource, displayName: string) => {
      const sourceFolderPath =
        source.kind === 'desktopFolder' ? source.path : null;
      setImportState({ kind: 'loading-zip', displayName });
      setBusy(true);
      try {
        const pack = await readPack(source);
        const suggested = await detectBackgroundResolution(pack);
        setImportState({
          kind: 'pick-resolution',
          payload: {
            displayName,
            pack,
            suggested,
            sourceFolder: sourceFolderPath,
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
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: false,
      title: t('fileEditor.import.openZip'),
      filters: [{ name: 'Resource pack (.zip)', extensions: ['zip'] }],
    });
    if (typeof result !== 'string') return;
    await startImport({ kind: 'desktopZip', path: result }, basename(result));
  };

  const openFolderImport = async () => {
    if (!desktop) return;
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

  const doSaveOverwrite = async () => {
    if (!desktop) return;
    if (!sourceFolder) {
      toast.error(t('toast.overwriteNoTarget'));
      return;
    }
    setBusy(true);
    try {
      const wall = useWallStore.getState().wall;
      const pack = await buildPackInWorker(wall);
      const { overwriteFolder } = await import('../adapters/desktop');
      const dest = await overwriteFolder(pack, sourceFolder);
      toast.success(t('toast.overwriteSuccess', { dest }));
    } catch (e) {
      console.error('overwrite failed', e);
      toast.error(t('toast.overwriteFailed', { error: errMsg(e) }));
    } finally {
      setBusy(false);
    }
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
