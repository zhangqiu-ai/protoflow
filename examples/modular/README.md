# 多頁模組化範例

此範例把原型依頁面、樣式與互動腳本拆分，應用使用獨立的原生 JavaScript 元件。目標專案僅使用共享 ProtoFlow 引擎、Skill 與配置；原型拆分不要求應用採同一目錄結構。

## 執行

先在共享引擎根目錄安裝依賴及 Chromium：

```sh
npm ci
npx playwright install chromium
cd examples/modular
```

預覽會自行啟動本地伺服器：

```sh
node server.js
```

開啟原型 `http://127.0.0.1:4319/prototype/pages/chat.html` 或應用 `http://127.0.0.1:4319/app/pages/chat.html`，再用導覽前往 Settings。按 Ctrl+C 停止。測試可用 `PROTOFLOW_MODULAR_PORT=0 node server.js` 或 `PORT=0 node server.js` 分配動態埠；啟動輸出顯示實際 URL。

完整驗證會自行啟動固定 4319 埠伺服器、建立 checkpoint/context、執行建置檢查、真正的 Playwright functional runner 與四個視覺狀態，最後停止伺服器：

```sh
node verify.js
```

執行此命令前先停止已有的範例預覽，以免 4319 埠衝突。結果和畫面證據保留在 `.protoflow/`；終端輸出包含 manifest、context、verification ID 及視覺報告路徑。此命令不自動批准 review 或建立 baseline。

也可以分別執行；Playwright 在未提供外部 URL 時會自行啟動並回收預覽伺服器：

```sh
node build.js
node run-tests.js
```

既有動態埠伺服器可供測試重用：

```sh
PROTOFLOW_MODULAR_URL=http://127.0.0.1:實際埠 node run-tests.js
```

`protoflow.config.json` 的 visual URL 預設使用 4319。若目標專案改用其他埠，請同步改配置的 scene URLs；功能測試則讀取 `PROTOFLOW_MODULAR_URL`。

## 檔案與映射

```text
prototype/
  pages/chat.html · settings.html
  styles/tokens.css · navigation.css · chat.css · settings.css
  scripts/chat.js · settings.js
app/
  pages/chat.html · settings.html
  styles/tokens.css · navigation.css · chat.css · settings.css
  components/Navigation.js · ChatPanel.js · SettingsPanel.js
tests/pages.spec.js
specs/modular.md
protoflow.config.json · server.js · build.js · run-tests.js · verify.js
```

應用的頁面組裝三個元件，沒有執行時引用原型檔案。兩套樣式獨立維護；一致性由視覺比較驗證。

| 原型檔案改動 | mapping | 對應應用元件 |
| --- | --- | --- |
| `styles/chat.css`、`scripts/chat.js` | `chat-panel` | `app/components/ChatPanel.js` |
| `styles/settings.css`、`scripts/settings.js` | `settings-panel` | `app/components/SettingsPanel.js` |
| `pages/chat.html` | `chat-panel`、`navigation-chat` | ChatPanel、Navigation |
| `pages/settings.html` | `settings-panel`、`navigation-settings` | SettingsPanel、Navigation |
| `styles/navigation.css` | 全部四個 mapping | 兩頁導覽及其影響的 panel 位置 |
| `styles/tokens.css` | 全部四個 mapping | 所有使用共用 token、基礎版面的區域 |

共用導覽樣式可能改變頁面內容位置，所以也保守列入兩頁 panel。表格的原型路徑相對於 `prototype/`。配置逐一列出精確檔案，沒有整個目錄的寬泛 glob。每頁 scene 明確指定該頁的 panel 與 navigation mapping，避免兩頁相同 `#navigation` selector 被混用。

聊天初始與送出後、設定初始與儲存後共四個 scene；它們一起覆蓋四個 mapping。每個 scene 同時比對整頁像素、映射區域像素、幾何與 computed styles。變更 tokens 後若缺少任一頁 scene，coverage 檢查會拒絕完整驗證。

聊天與名稱儲存只展示本地互動，不連線、不持久化；導覽會載入另一頁初始狀態。範例驗證通過仍需要人工 review 才能建立 UI baseline。

## 自己修改後接續流程

原型版本可以連續 checkpoint；正式應用依 `node ../../bin/protoflow.js queue` 的 `current` 逐一 context／verify，PASS 後才處理下一個版本。保持預覽執行，另一個終端在本目錄執行：

```sh
node ../../bin/protoflow.js session start --label "Chat spacing"
# 編輯 prototype/styles/chat.css，然後 checkpoint
node ../../bin/protoflow.js checkpoint --summary "Adjust chat panel spacing"
node ../../bin/protoflow.js context --manifest <MANIFEST_ID> --spec specs/modular.md
# 按 context 修改映射應用檔案，並維護 Playwright 測試
node ../../bin/protoflow.js verify --manifest <MANIFEST_ID>
node ../../bin/protoflow.js review create --manifest <MANIFEST_ID> --verification <VERIFICATION_ID>
# 人工檢視畫面、diff 與驗證資料後才記錄批准
node ../../bin/protoflow.js review approve --review <REVIEW_ID> --reviewer "你的名稱"
node ../../bin/protoflow.js baseline create --review <REVIEW_ID>
```

每次批准綁定當前內容與驗證證據；之後修改應用或原型需要重新驗證和 review。
