import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// i18n を React ツリー生成前に初期化する。副作用 import。
import { initOsLanguage } from "./i18n";

// Desktop では OS 表示言語を初期言語に反映してから描画する（Web は no-op）。
// 失敗しても同期初期化済みの言語で描画は進む。
void initOsLanguage().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
