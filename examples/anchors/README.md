# 語意錨點範例（schemaVersion 2）

兩個畫面的任務應用：原型以 `data-pf` 標記錨點，應用以 `data-testid` 帶上相同 ID，兩邊程式碼各自獨立（應用以資料渲染清單）。設計見 [提案 0001](../../docs/proposals/0001-anchor-contracts.md)。

```text
prototype/
  tasks.html · tasks.pf.json · tasks.js     畫面 tasks：initial、empty-error、added
  settings.html · settings.pf.json · settings.js   畫面 settings：initial、saved
  styles.css · tokens.json                  W3C Design Tokens
app/
  tasks.html · tasks.js · settings.html · settings.js · styles.css
tests/app.spec.js                           應用自己的 Playwright 功能測試
protoflow.config.json                       一個 web target，urlTemplate app/{page}.html
```

配置沒有 `mappings` 或 `visual.scenes`：場景由畫面與 sidecar 狀態產生，新增原型頁面也不需改配置。

在共享引擎根目錄執行：

```sh
node bin/protoflow.js anchors lint --project examples/anchors
node bin/protoflow.js checkpoint --project examples/anchors --summary "Tasks v1"
node bin/protoflow.js contract show --project examples/anchors --manifest MANIFEST_ID
node bin/protoflow.js verify --project examples/anchors --manifest MANIFEST_ID
```

首次 checkpoint 含原型腳本，分級為 L2；建立 context 時需以 `--spec` 提供已審規格。`verify` 依序執行 build、功能測試與四層比較，報告位於 `.protoflow/artifacts/VER_ID/report.html`。`tests/e2e/anchors.spec.js` 以此範例驗證四層通過、各層偵測漂移、新增畫面、無效錨點與外部驅動器協定。
