/**
 * App — シェル。サイドバー＋メイン領域の構成。
 * サイドバー: 左端のレール（編集項目の切替。Desktop は先頭に「ファイル」）＋エディタパネル
 * メイン: 上端のバー（Web のみ。タイトルと Import/Export）＋ WallPreview
 *
 * レスポンシブ:
 *  - md (>=768px): 3 列グリッド（レール / エディタ / メイン）の固定高さレイアウト。
 *    エディタとプレビューはそれぞれの列の中で縦スクロールする。
 *  - 狭幅 (<768px): ヘッダ → 横並びのナビ → エディタ → プレビューの縦並び（自然な高さ）。
 *    グリッド全体が縦スクロールする。ヘッダは DOM 上はエディタの後ろにある（md での
 *    フォーカス順をレール → エディタ → メインにするため）ので、狭幅でだけ先頭へ並べ替える。
 *
 * タブ本文は `React.lazy` で分割する。`TabsContent` はアクティブなタブしか描画しないのに
 * 静的 import では全エディタが初期チャンクに入り、`react-colorful`（BackgroundEditor →
 * CropModal）や `@ffmpeg/ffmpeg` ラッパ（SoundsEditor → audio/convert）まで初回に載る。
 */

import { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from './adapters';
import { AppHeader } from './components/AppHeader';
import { AppRail, type EditorTab } from './components/AppRail';
import { HistoryControls } from './components/HistoryControls';
import { WallPreview, type PreviewTarget } from './components/WallPreview';
import {
  InfoTooltip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './components/ui';
import { FileOperationsProvider } from './hooks/useFileOperations';
import { useWallStore } from './store/useWallStore';
import './App.css';

// 各エディタは名前付き export なので default に詰め替えてから lazy に渡す。
// 目当ての分割は BackgroundEditor（+ CropModal + react-colorful）と
// SoundsEditor（+ audio/convert → @ffmpeg/*）だが、扱いを揃えて全タブを遅延させる。
const BackgroundEditor = lazy(() =>
  import('./components/BackgroundEditor').then((m) => ({
    default: m.BackgroundEditor,
  })),
);
const FileEditor = lazy(() =>
  import('./components/FileEditor').then((m) => ({ default: m.FileEditor })),
);
const LayoutEditor = lazy(() =>
  import('./components/LayoutEditor').then((m) => ({ default: m.LayoutEditor })),
);
const LockImagesEditor = lazy(() =>
  import('./components/LockImagesEditor').then((m) => ({
    default: m.LockImagesEditor,
  })),
);
const PackInfoEditor = lazy(() =>
  import('./components/PackInfoEditor').then((m) => ({
    default: m.PackInfoEditor,
  })),
);
const SoundsEditor = lazy(() =>
  import('./components/SoundsEditor').then((m) => ({
    default: m.SoundsEditor,
  })),
);
// 更新通知バナー（Desktop のみ描画。Web の初期チャンクに入れない）
const DesktopUpdateNotice = lazy(() =>
  import('./components/DesktopUpdateNotice').then((m) => ({
    default: m.DesktopUpdateNotice,
  })),
);

/**
 * タブ本文のチャンク取得中に出すプレースホルダ。
 * チャンクは同一オリジンの小さな JS なので通常は一瞬で解決する。スピナー等は置かず、
 * 高さだけ確保して切替時にパネルが潰れないようにする。
 */
function TabFallback() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex min-h-40 items-center justify-center text-sm text-fg-subtle"
    >
      {t('common.loading')}
    </div>
  );
}

const EDITOR_TABS: readonly EditorTab[] = [
  'info',
  'layout',
  'background',
  'lock',
  'sound',
];
const DESKTOP_EDITOR_TABS: readonly EditorTab[] = ['file', ...EDITOR_TABS];

const PREVIEW_TARGETS: readonly PreviewTarget[] = [
  'all',
  'background',
  'layout',
  'none',
];

/**
 * プレビュー見出しの切替（ボックス表示 / スナップ先）。ラベルと 4 択のタブ。
 * `optionKey` は各選択肢のラベルの i18n キーの親（`<optionKey>.<all|background|…>`）。
 */
function PreviewTargetTabs({
  label,
  info,
  value,
  onChange,
  optionKey,
}: {
  label: string;
  info?: string;
  value: PreviewTarget;
  onChange: (next: PreviewTarget) => void;
  optionKey: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-fg-subtle">
        {label}
        {info && <InfoTooltip text={info} />}
      </span>
      <Tabs value={value} onValueChange={(v) => onChange(v as PreviewTarget)}>
        <TabsList className="h-8" aria-label={label}>
          {PREVIEW_TARGETS.map((mode) => (
            <TabsTrigger key={mode} value={mode} className="h-6 px-2.5 text-xs">
              {t(`${optionKey}.${mode}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  // Tauri webview 内かどうか。__TAURI_INTERNALS__ は webview 起動時に注入され
  // 後から変わることはないので、レンダー時に都度参照しても問題ない。
  const desktop = isTauri();

  const [tab, setTab] = useState<EditorTab>(desktop ? 'file' : 'info');
  const [boxMode, setBoxMode] = useState<PreviewTarget>('all');
  const [snapMode, setSnapMode] = useState<PreviewTarget>('all');
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
        {desktop && (
          <Suspense fallback={null}>
            <DesktopUpdateNotice />
          </Suspense>
        )}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as EditorTab)}
          // 狭幅の暗黙行は max-content。auto のままだとスクロールコンテナ（横スクロールのナビ）の
          // 最小高さが 0 扱いになり、全体が画面より高いときにナビが潰れる。
          className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto md:grid-cols-[84px_clamp(280px,30vw,420px)_minmax(0,1fr)] md:grid-rows-[auto_minmax(0,1fr)] md:overflow-hidden"
        >
          <AppRail
            tabs={desktop ? DESKTOP_EDITOR_TABS : EDITOR_TABS}
            value={tab}
            onValueChange={setTab}
            showReset={!desktop}
            className="md:row-span-2"
          />

          {/* サイドバー: エディタパネル */}
          <section
            aria-label={t(`tab.${tab}`)}
            className="flex flex-col border-b border-border bg-surface md:row-span-2 md:min-h-0 md:border-r md:border-b-0"
          >
            {/* 取り消し / やり直しはどのタブの編集にも効くので、パネル見出しに常に置く */}
            <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
              <h2 className="text-sm font-semibold text-fg">
                {t(`tab.${tab}`)}
              </h2>
              <HistoryControls />
            </div>
            <div className="p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
              {/* TabsContent は非アクティブなタブを描画しないので、
                  Suspense はパネル領域にひとつあれば足りる。 */}
              <Suspense fallback={<TabFallback />}>
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
                <TabsContent value="background">
                  <BackgroundEditor />
                </TabsContent>
                <TabsContent value="lock">
                  <LockImagesEditor />
                </TabsContent>
                <TabsContent value="sound">
                  <SoundsEditor />
                </TabsContent>
              </Suspense>
            </div>
          </section>

          {/* メイン: 上端のバー（Web のみ）。狭幅ではページ先頭に出す */}
          {!desktop && (
            <AppHeader className="max-md:order-first md:col-start-3 md:row-start-1" />
          )}

          {/* メイン: プレビュー */}
          <main className="flex flex-col p-5 md:col-start-3 md:row-start-2 md:min-h-0 md:overflow-y-auto">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-fg">
                {t('preview.title')}
              </h2>
              {/* 狭幅では各グループ内でもラベルが切替の上に折り返す（横にはみ出さない） */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {/* 枠の表示切替。見た目確認時に枠を消したり、片方だけ操作したりする用 */}
                <PreviewTargetTabs
                  label={t('preview.boxes')}
                  value={boxMode}
                  onChange={setBoxMode}
                  optionKey="preview.boxMode"
                />
                {/* 吸着先の切替。枠を隠している側にはこの設定に関わらず吸着しない */}
                <PreviewTargetTabs
                  label={t('preview.snap')}
                  info={t('preview.snapInfo')}
                  value={snapMode}
                  onChange={setSnapMode}
                  optionKey="preview.snapMode"
                />
              </div>
            </div>
            <WallPreview
              boxMode={boxMode}
              snapMode={snapMode}
              backgroundEditing={tab === 'background'}
            />
            <p className="mt-3 text-xs text-fg-subtle">{t('preview.hint')}</p>
          </main>
        </Tabs>
      </div>
    </FileOperationsProvider>
  );
}

export default App;
