/**
 * DialogWindowApp — Desktop 版で、別ウィンドウに開いたダイアログ 1 つを描くルート。
 *
 * `main.tsx` が URL の `?dialog=` を見て、App の代わりにこれを描く（store も編集画面も読まない）。
 * OS のタイトルバーは出さないので、見出し行をドラッグ領域にし、右端に × を置く。
 * 操作の結果は `getDialogBridge` 経由でメインウィンドウへ送り、閉じるのはメイン側に任せる。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDialogBridge, type DialogBridge } from '../../adapters';
import { setLanguage } from '../../i18n';
import { AboutContent } from '../AboutModal';
import { CropEditor } from '../CropModal';
import { ImportResolutionForm } from '../ImportResolutionDialog';
import { ConfirmBody } from '../ui/ConfirmDialog';
import { CloseIcon } from '../ui/icons';
import type {
  DialogMessage,
  DialogPayload,
  DialogSpec,
  DialogState,
} from './dialogSpec';
// App を読まないウィンドウなので、トークンや下地のスタイルはここで読み込む
import '../../App.css';

/**
 * 高さの上限（論理 px）。画面の作業領域に収め、超えた分は本文をスクロールする。
 * 切り抜き（画像 600px ＋入力欄）が 1080p・拡大 125% でも収まるよう、固定値にはしない。
 */
const maxHeight = () => Math.max(320, window.screen.availHeight - 48);

export function DialogWindowApp({ spec, id }: { spec: DialogSpec; id: string }) {
  const { t } = useTranslation();
  const [bridge, setBridge] = useState<DialogBridge | null>(null);
  const [state, setState] = useState<DialogState>({});
  const [payload, setPayload] = useState<DialogPayload | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void getDialogBridge(id).then(async (b) => {
      if (disposed) return;
      cleanups.push(
        await b.onPayload(setPayload),
        await b.onState(setState),
        await b.interceptClose(),
      );
      setBridge(b);
      b.send({ type: 'ready' });
    });
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [id]);

  const send = (m: DialogMessage) => bridge?.send(m);
  const dismiss = () => send({ type: 'dismiss' });

  // ウィンドウの高さを中身に合わせる。最初に合わせてから表示し、以降も中身の増減
  // （インポートで「カスタム」を選んだときの入力欄など）に追従する。
  useEffect(() => {
    const content = contentRef.current;
    if (!bridge || !content) return;
    let shown = false;
    const fit = () => {
      // 見出し行 44px ＋ 本文の上下余白 40px ＋ 枠線 2px
      const height = Math.min(maxHeight(), Math.ceil(content.offsetHeight) + 86);
      void bridge.setHeight(height).then(() => {
        if (shown) return;
        shown = true;
        return bridge.show();
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => observer.disconnect();
  }, [bridge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') bridge?.send({ type: 'dismiss' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge]);

  return (
    <div
      className="flex h-screen flex-col border border-border bg-surface"
      role="dialog"
      aria-labelledby="dialog-title"
    >
      <div
        data-tauri-drag-region
        className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border pl-5"
      >
        <h2
          id="dialog-title"
          data-tauri-drag-region
          className="truncate text-base font-semibold text-fg"
        >
          {spec.title}
        </h2>
        <button
          type="button"
          onClick={dismiss}
          className="flex h-full w-12 flex-shrink-0 cursor-default items-center justify-center text-fg-muted hover:bg-[#c42b1c] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div ref={contentRef}>
        {spec.kind === 'about' && (
          <AboutContent
            onLanguageChange={(lng) => {
              void setLanguage(lng);
              send({ type: 'action', name: 'language', value: lng });
            }}
          />
        )}
        {spec.kind === 'confirm' && (
          <ConfirmBody
            message={spec.message}
            confirmLabel={spec.confirmLabel}
            cancelLabel={spec.cancelLabel}
            confirmVariant={spec.confirmVariant}
            onConfirm={() => send({ type: 'result' })}
            onCancel={dismiss}
          />
        )}
        {spec.kind === 'crop' && payload && (
          <CropEditor
            imageUrl={payload.imageUrl ?? null}
            initialCrop={spec.crop}
            onClose={dismiss}
            onApply={(crop) => send({ type: 'result', value: crop })}
          />
        )}
        {spec.kind === 'importResolution' && (
          <ImportResolutionForm
            fileName={spec.fileName}
            suggested={spec.suggested}
            current={spec.current}
            busy={state.busy}
            exporting={state.exporting}
            onExportCurrent={() => send({ type: 'action', name: 'exportCurrent' })}
            onCancel={dismiss}
            onConfirm={(resolution) => send({ type: 'result', value: resolution })}
          />
        )}
        </div>
      </div>
    </div>
  );
}
