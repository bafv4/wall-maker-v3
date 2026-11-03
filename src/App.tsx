/**
 * App — シェル。サイドバー＋メイン領域の構成。
 * サイドバー: 左端のレール（編集項目の切替。先頭は「ファイル」）＋エディタパネル
 * メイン: 上端のバー（タイトルとリリースへのリンク）＋ WallPreview
 *
 * インポート / エクスポート / リセットは Web・Desktop とも「ファイル」タブに集約する。
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

import { Suspense, lazy, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from './adapters';
import { AppHeader } from './components/AppHeader';
import { AppRail, type EditorTab } from './components/AppRail';
import { SidebarResizer } from './components/SidebarResizer';
import { HistoryControls } from './components/HistoryControls';
import { WallPreview, type PreviewTarget } from './components/WallPreview';
import {
  cn,
  InfoTooltip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './components/ui';
import { SidebarIcon } from './components/ui/icons';
import { FileOperationsProvider } from './hooks/useFileOperations';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useWallStore } from './store/useWallStore';
import './App.css';

// 各エディタは名前付き export なので default に詰め替えてから lazy に渡す。
// 目当ての分割は BackgroundEditor（+ CropModal + react-colorful）と
// SoundsEditor（+ audio/convert → @ffmpeg/*）だが、扱いを揃えて全タブを遅延させる。
const loadBackgroundEditor = () =>
  import('./components/BackgroundEditor').then((m) => ({
    default: m.BackgroundEditor,
  }));
const loadFileEditor = () =>
  import('./components/FileEditor').then((m) => ({ default: m.FileEditor }));
const loadLayoutEditor = () =>
  import('./components/LayoutEditor').then((m) => ({ default: m.LayoutEditor }));
const loadLockImagesEditor = () =>
  import('./components/LockImagesEditor').then((m) => ({
    default: m.LockImagesEditor,
  }));
const loadPackInfoEditor = () =>
  import('./components/PackInfoEditor').then((m) => ({
    default: m.PackInfoEditor,
  }));
const loadSoundsEditor = () =>
  import('./components/SoundsEditor').then((m) => ({
    default: m.SoundsEditor,
  }));
const BackgroundEditor = lazy(loadBackgroundEditor);
const FileEditor = lazy(loadFileEditor);
const LayoutEditor = lazy(loadLayoutEditor);
const LockImagesEditor = lazy(loadLockImagesEditor);
const PackInfoEditor = lazy(loadPackInfoEditor);
const SoundsEditor = lazy(loadSoundsEditor);

/**
 * 初回表示が落ち着いたら残りのタブのチャンクを先に取っておく。初期チャンクは軽いまま、
 * タブを切り替えた瞬間に「読込中…」でパネルが空になるのを避ける（import はキャッシュされる）。
 */
function prefetchEditors() {
  for (const load of [
    loadFileEditor,
    loadPackInfoEditor,
    loadLayoutEditor,
    loadBackgroundEditor,
    loadLockImagesEditor,
    loadSoundsEditor,
  ]) {
    void load().catch(() => {
      // 先読みに失敗しても、タブを開いたときに lazy が取り直す
    });
  }
}
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
  'file',
  'info',
  'layout',
  'background',
  'lock',
  'sound',
];

/**
 * 開いていたタブは閲覧者ごとの好みとして localStorage に覚え、次回はそこから始める
 * （編集中の状態も残っているので、毎回ファイルタブから入り直させない）。
 * 初回や読めない環境では、パックの読み込みから始められるファイルタブ。
 */
const TAB_STORAGE_KEY = 'wall-maker:editor-tab';

function loadEditorTab(): EditorTab {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return EDITOR_TABS.find((tab) => tab === v) ?? 'file';
  } catch {
    return 'file';
  }
}

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

/** サイドバーの開閉ボタン。`expanded` は今サイドバーが開いているか。 */
function SidebarToggle({
  expanded,
  onClick,
  className,
}: {
  expanded: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = expanded ? t('sidebar.collapse') : t('sidebar.expand');
  return (
    <button
      type="button"
      data-sidebar-toggle
      onClick={onClick}
      aria-expanded={expanded}
      className={cn(
        'flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        className,
      )}
      aria-label={label}
      title={t('sidebar.toggleTitle', { label })}
    >
      <SidebarIcon />
    </button>
  );
}

function App() {
  const { t } = useTranslation();
  // Tauri webview 内かどうか。__TAURI_INTERNALS__ は webview 起動時に注入され
  // 後から変わることはないので、レンダー時に都度参照しても問題ない。
  const desktop = isTauri();

  const [tab, setTabState] = useState<EditorTab>(loadEditorTab);
  // レールの選択は押した瞬間に切り替え、パネルだけ遅れて追従させる。パネルのチャンク解決を
  // 待つ間は前のタブを出したままにする（先読み済みでも lazy は 1 拍 suspend するので、
  // そのままだと切り替えのたびに「読込中…」が一瞬出る）
  const panelTab = useDeferredValue(tab);
  const setTab = (next: EditorTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // 保存できなくてもタブの切り替え自体は続ける
    }
  };
  const [boxMode, setBoxMode] = useState<PreviewTarget>('all');
  const [snapMode, setSnapMode] = useState<PreviewTarget>('all');
  const [hydrated, setHydrated] = useState(false);
  // サイドバー（エディタパネル）の幅。右端の境界線で変えられる
  const sidebar = useSidebarWidth();
  const sidebarRef = useRef<HTMLElement>(null);
  const { collapsed, setCollapsed } = sidebar;

  // 開閉ボタンはサイドバー見出し（開いているとき）とメインのヘッダ（閉じているとき）で
  // 入れ替わるので、ボタンで開閉したらもう一方のボタンへフォーカスを運ぶ
  const focusToggleRef = useRef(false);
  const toggleSidebar = () => {
    focusToggleRef.current = true;
    setCollapsed(!collapsed);
  };
  useEffect(() => {
    if (!focusToggleRef.current) return;
    focusToggleRef.current = false;
    // 閉じたサイドバーは display:none で DOM に残るので、見えている方を選ぶ
    Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-toggle]'))
      .find((el) => el.offsetParent !== null)
      ?.focus();
  }, [collapsed]);

  // Ctrl+B（macOS は ⌘B）で開閉。エディタ系アプリの慣例に合わせる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setCollapsed(!collapsed);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, setCollapsed]);

  useEffect(() => {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(prefetchEditors, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetchEditors, 1000);
    return () => window.clearTimeout(id);
  }, []);

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
      <div
        className="flex h-screen flex-col bg-canvas text-fg"
        style={{ '--sidebar-w': sidebar.cssWidth } as React.CSSProperties}
      >
        {desktop && (
          <Suspense fallback={null}>
            <DesktopUpdateNotice />
          </Suspense>
        )}

        <Tabs
          value={panelTab}
          onValueChange={(v) => setTab(v as EditorTab)}
          // 狭幅の暗黙行は max-content。auto のままだとスクロールコンテナ（横スクロールのナビ）の
          // 最小高さが 0 扱いになり、全体が画面より高いときにナビが潰れる。
          className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto md:grid-cols-[84px_var(--sidebar-w)_minmax(0,1fr)] md:grid-rows-[auto_minmax(0,1fr)] md:overflow-hidden"
        >
          <AppRail
            tabs={EDITOR_TABS}
            value={tab}
            onValueChange={setTab}
            className="md:row-span-2"
          />

          {/* サイドバー: エディタパネル */}
          <section
            ref={sidebarRef}
            aria-label={t(`tab.${tab}`)}
            className={cn(
              'relative flex flex-col border-b border-border bg-surface md:row-span-2 md:min-h-0 md:border-r md:border-b-0',
              collapsed && 'md:hidden',
            )}
          >
            <SidebarResizer
              width={sidebar.width}
              onChange={sidebar.setWidth}
              targetRef={sidebarRef}
            />
            {/* 取り消し / やり直しはどのタブの編集にも効くので、パネル見出しに常に置く */}
            {/* Desktop ではここもウィンドウを掴んで動かせる（OS のタイトルバーが無いため） */}
            <div
              data-tauri-drag-region
              className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4 md:pl-2"
            >
              <div className="flex min-w-0 items-center gap-1">
                {/* 閉じるのは md 以上のみ（狭幅は縦積みでプレビューを狭めないため） */}
                <SidebarToggle
                  expanded
                  onClick={toggleSidebar}
                  className="hidden md:flex"
                />
                <h2 className="truncate text-lg font-semibold text-fg">
                  {t(`tab.${tab}`)}
                </h2>
              </div>
              <HistoryControls />
            </div>
            <div className="p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
              {/* TabsContent は非アクティブなタブを描画しないので、
                  Suspense はパネル領域にひとつあれば足りる。 */}
              <Suspense fallback={<TabFallback />}>
                {/* 高さをパネルいっぱいにして、リセットを下端に寄せられるようにする */}
                <TabsContent value="file" className="flex min-h-full flex-col">
                  <FileEditor />
                </TabsContent>
                <TabsContent value="info">
                  <PackInfoEditor />
                </TabsContent>
                <TabsContent value="layout">
                  <LayoutEditor />
                </TabsContent>
                {/* 下端に「レイヤを追加」を固定するため、高さをパネルいっぱいにする */}
                <TabsContent value="background" className="flex min-h-full flex-col">
                  <BackgroundEditor />
                </TabsContent>
                <TabsContent value="lock" className="flex min-h-full flex-col">
                  <LockImagesEditor />
                </TabsContent>
                <TabsContent value="sound">
                  <SoundsEditor />
                </TabsContent>
              </Suspense>
            </div>
          </section>

          {/* メイン: 上端のバー。狭幅ではページ先頭に出す */}
          {/* サイドバーを閉じている間は、開閉ボタンと取り消し / やり直しをタイトルの左に移す */}
          <AppHeader
            className="max-md:order-first md:col-start-3 md:row-start-1"
            leading={
              collapsed && (
                <div className="hidden items-center gap-1 md:flex">
                  <SidebarToggle expanded={false} onClick={toggleSidebar} />
                  <HistoryControls />
                </div>
              )
            }
          />

          {/* メイン: プレビュー */}
          <main className="flex flex-col p-5 md:col-start-3 md:row-start-2 md:min-h-0 md:overflow-y-auto">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              {/* 操作説明は常設の段落にせず、見出し横のⓘにしまう（キャンバスに高さを回す） */}
              <h2 className="flex items-center gap-1.5 text-lg font-semibold text-fg">
                {t('preview.title')}
                <InfoTooltip text={t('preview.hint')} />
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
          </main>
        </Tabs>
      </div>
    </FileOperationsProvider>
  );
}

export default App;
