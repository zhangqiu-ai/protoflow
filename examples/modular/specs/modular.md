# 模組化範例規格

此文件提供初次 checkpoint 的 Spec Kit 接入證據範例；實際人工批准仍透過獨立 review 記錄。

## 功能與驗收

- Chat 頁顯示共用導覽、既有訊息及 Message 輸入；送出非空白內容後，訊息清單追加 You 的純文字訊息，清空輸入。
- Settings 頁顯示共用導覽與 Display name 欄位；儲存非空白名稱後，status 區域顯示 `Display name saved: <name>`。
- Chat 與 Settings 導覽可互相切換，當前頁連結具有 `aria-current="page"`。
- 本地範例不連接服務、不持久化聊天與設定；導覽重載各頁的初始狀態。
- 原型與應用的初始與互動後狀態須通過 functional Playwright runner 和四個 mapping 的視覺比較。

## 變更範圍

chat.css 或 chat.js 只映射 chat-panel；settings.css 或 settings.js 只映射 settings-panel。
頁面 HTML 保守映射該頁 panel 與導覽。共用 tokens.css 映射四個區域；navigation.css 保守映射兩頁導覽及其影響的 panel，共四個區域。
應用以原生 JavaScript 元件組成，獨立維護應用檔案；不引用或複製共享引擎進入目標專案。
