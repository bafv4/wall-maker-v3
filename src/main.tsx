import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// バレル（./components/ui）経由だとエントリチャンクが UI 一式を巻き込むため直接参照する。
import { ToastRoot } from "./components/ui/Toast";
// i18n を React ツリー生成前に初期化する。副作用 import。
import { initOsLanguage } from "./i18n";
import { isTauri } from "./adapters";
import { DialogWindowApp } from "./components/dialogs/DialogWindowApp";
import { readDialogParams } from "./components/dialogs/dialogSpec";

// Desktop 版で別ウィンドウに開いたダイアログは、App（store・編集画面）を読まずに
// ダイアログだけを描く。どのダイアログかは URL の `?dialog=` で受け取る。
const dialog = readDialogParams();

// Desktop 版では WebView の右クリックメニュー（戻る・再読み込み・検証など）を出さない。
// 入力欄だけはコピー・貼り付けに使うので残す。Web 版はブラウザの標準動作のまま。
if (isTauri()) {
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
}

// Desktop では OS 表示言語を初期言語に反映してから描画する（Web は no-op）。
// 失敗しても同期初期化済みの言語で描画は進む。
void initOsLanguage().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {dialog ? <DialogWindowApp spec={dialog.spec} id={dialog.id} /> : <App />}
      {/*
        ToastRoot は App の外＝ハイドレートゲートの外に置く。App の中に置くと
        「読み込み中」の early return より後ろになり、store 復元失敗の通知
        （persistAdapter）を出す先が無くなる。store には依存しない。
      */}
      <ToastRoot />
    </React.StrictMode>,
  );
});
