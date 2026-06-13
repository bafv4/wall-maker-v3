/**
 * App — シェル。
 * 左: タブ式エディタ（Desktop は最左に「ファイル」タブを差し込む）
 * 右: WallPreview
 * 上: Header（Web のみ。Desktop ではヘッダーを表示せずファイルタブに集約）
 *
 * レスポンシブ:
 *  - md (>=768px): 2 カラム（エディタ 1 / プレビュー 2）の固定高さレイアウト。
 *    内部の長いコンテンツはタブ本文の `overflow-y-auto` でスクロール。
 *  - 狭幅 (<768px): 縦並びの自然な高さレイアウトに切り替え、`main` 自体が縦スクロール。
 *    `h-full` + `flex-1` の入れ子は親が auto-height だと 0 に潰れるため、
 *    `md:` プレフィックスで固定高さ前提の構造を解除する。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from './adapters';
import { AppHeader } from './components/AppHeader';
import { BackgroundEditor } from './components/BackgroundEditor';
import { FileEditor } from './components/FileEditor';
import { LayoutEditor } from './components/LayoutEditor';
import { LockImagesEditor } from './components/LockImagesEditor';
import { PackInfoEditor } from './components/PackInfoEditor';
import { SoundsEditor } from './components/SoundsEditor';
import { WallPreview } from './components/WallPreview';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastRoot,
  cn,
} from './components/ui';
import { FileOperationsProvider } from './hooks/useFileOperations';
import { useWallStore } from './store/useWallStore';
import './App.css';

function App() {
  const { t } = useTranslation();
  // Tauri webview 内かどうか。__TAURI_INTERNALS__ は webview 起動時に注入され
  // 後から変わることはないので、レンダー時に都度参照しても問題ない。
  const desktop = isTauri();

  const [tab, setTab] = useState(desktop ? 'file' : 'info');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const unsub = useWallStore.persist.onFinishHydration(() => setHydrated(true));
    if (useWallStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">
        {t('app.loading')}
      </div>
    );
  }

  return (
    <FileOperationsProvider>
      <div className="flex h-screen flex-col bg-canvas text-fg">
        {!desktop && <AppHeader />}

        <main className="flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          <div
            className={cn(
              'mx-auto max-w-[1920px] md:h-full',
              // Desktop は AppHeader が無いぶん上下にも余白が必要。全方向に均等な余白を取り、
              // Web より少し広めにして「ウィンドウ枠とコンテンツ」のリズムを揃える。
              desktop ? 'p-6' : 'px-5 py-5',
            )}
          >
            <div className="grid grid-cols-1 gap-5 md:h-full md:grid-cols-3">
              {/* Left: Editors */}
              <div className="md:col-span-1 md:min-h-0">
                <div className="flex flex-col rounded-lg border border-border bg-surface md:h-full">
                  <Tabs
                    value={tab}
                    onValueChange={setTab}
                    className="flex flex-col md:h-full"
                  >
                    {/* タブが入り切らない場合は横スクロール。内側に inline-flex の TabsList が並ぶ。 */}
                    <div className="border-b border-border p-3 md:flex-shrink-0">
                      <div className="overflow-x-auto">
                        <TabsList>
                          {desktop && (
                            <TabsTrigger value="file">{t('tab.file')}</TabsTrigger>
                          )}
                          <TabsTrigger value="info">{t('tab.info')}</TabsTrigger>
                          <TabsTrigger value="layout">{t('tab.layout')}</TabsTrigger>
                          <TabsTrigger value="background">{t('tab.background')}</TabsTrigger>
                          <TabsTrigger value="lock">{t('tab.lock')}</TabsTrigger>
                          <TabsTrigger value="sound">{t('tab.sound')}</TabsTrigger>
                        </TabsList>
                      </div>
                    </div>
                    <div className="p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
                      {desktop && (
                        <TabsContent value="file">
                          <FileEditor />
                        </TabsContent>
                      )}
                      <TabsContent value="info">
                        <PackInfoEditor />
                      </TabsContent>
                      <TabsContent value="layout">
                        <LayoutEditor />
                      </TabsContent>
                      <TabsContent value="background" className="md:h-full">
                        <BackgroundEditor />
                      </TabsContent>
                      <TabsContent value="lock">
                        <LockImagesEditor />
                      </TabsContent>
                      <TabsContent value="sound">
                        <SoundsEditor />
                      </TabsContent>
                    </div>
                  </Tabs>
                </div>
              </div>

              {/* Right: Preview */}
              <div className="md:col-span-2 md:min-h-0">
                <div className="flex flex-col rounded-lg border border-border bg-surface p-4 md:h-full">
                  <h2 className="mb-3 text-sm font-semibold text-fg">
                    {t('preview.title')}
                  </h2>
                  <div className="md:flex-1 md:min-h-0">
                    <WallPreview />
                  </div>
                  <p className="mt-3 text-xs text-fg-subtle">
                    {t('preview.hint')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
        <ToastRoot />
      </div>
    </FileOperationsProvider>
  );
}

export default App;
