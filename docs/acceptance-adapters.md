# 專案驗收 adapter（schemaVersion 1）

專案可自行提供應用啟動、功能測試及視覺擷取，使用共享引擎的 `protoflow.acceptance/1` 雙向 JSONL 協定。這是 `schemaVersion: 1` mapping 流程的選用介接；`schemaVersion: 2` 的 targets、anchors 與 driver 協定保持獨立。單獨設定 `visual.mode: "native"` 仍是 `NOT_RUN`。

```json
{
  "verification": {"build": {"argv": ["npm", "run", "build"]}, "functional": {"adapter": "acceptance"}},
  "adapters": {"acceptance": {"command": {"argv": ["node", "scripts/acceptance.mjs"], "timeoutMs": 180000}, "options": {}}},
  "visual": {"mode": "adapter", "scenes": [{"id": "initial", "prototypeUrl": "prototype/index.html", "applicationUrl": "app/index.html", "viewport": {"width": 1000, "height": 760}}]}
}
```

這是合併至完整 v1 配置的片段，仍需實際 mappings。專案從共享套件匯入 `acceptanceClient`、`runAcceptanceCommand`，不得複製引擎。後者以 Node bridge 執行明確 argv；測試命令只在 supervisor 確認已記錄 bridge PID 後開始。應用的獨立 POSIX 程序群組由專案工具建立並回報。Windows 無法提供此程序群組保證，不能以協定 PASS 宣稱完成原生驗收。

stdin 首行帶 `schemaVersion: 1`、`protocol: "protoflow.acceptance/1"`、隨機 `requestId`、`phase: "functional"|"visual"`、`projectRoot`、`options` 與呼叫端傳入的版本證據。workflow 應提供 `manifestId`、`manifestHash`、`prototypeHash`、`source`、`prototypeVersion`。視覺請求另帶 `scene`、`sceneHash`、`applicationUrl`、`capturePath`、`mappings`、`requestedCapture`。stdout 僅輸出 JSONL 事件，日誌送 stderr；不能混入一般 console 輸出。

每個事件必須依序帶 `seq: 1,2,...`。SDK 方法等待 supervisor 回覆 `{ack: seq, ok: true}`：

1. `await client.starting(id)`：核心及 Runner callbacks 確認 STARTING 後才啟動該程序。
2. `await client.started(id, pid)`：`pid` 必須是 adapter 的後代與獨立群組 leader，`pgid=pid`；確認 PID 保存後才操作應用。
3. 正常關閉後 `await client.finished(id, status)`：核心另查 PID／全組已消失。只有 OS 明確拒絕 spawn、且證明沒有子程序時才能使用 `notStarted`；未知 PID 會阻塞恢復。
4. `await client.result({...})`：須回傳原 `schemaVersion`、`requestId`、`phase` 及 `status: "PASS"|"FAIL"|"NOT_RUN"`，所有已宣告子程序均須完成。PASS 必須帶 `applicationSurface: {kind, processId}`，對應實際監督的已完成應用 PID。functional PASS 另需 `functional: {status: "PASS", exitCode: 0, stdout, stderr}`。
5. `client.close()` 關閉協定輸入；adapter 自身也須正常 exit 0。

Runner 提供持久化 callbacks 才能建立跨程序重啟的 STARTING／RUNNING／完成證據。單次直接呼叫 API 只監督本次程序，不能宣稱有 Runner 的持久恢復保證。零退出碼、缺結果、未綁定應用 PID 或未執行驗證均不能 PASS。

崩潰、超時、中止、協定錯誤時只清理已確認屬本次的程序群組；強制清理屬 FAIL，不能當作正常關閉成功。adapter 崩潰而其 detached 子程序仍持有輸出 pipes 時，EOF 等待有界，然後清理已記錄的群組。未知啟動 PID、群組仍存活或持久化失敗會阻塞後續版本。協定防止漏記與孤兒程序，仍信任專案 adapter 正確操作產品；各平台須另外以重複測試驗證正常關閉期限、exit code、signal 與群組消失。

visual PASS 須原樣回傳 `sceneId`、`sceneHash`、`stateReady: true`，以及 `capture: {path: capturePath, parameters: requestedCapture}`。adapter 必須執行相同 fixture／steps、viewport、字型／圖片穩定等待與環境設定，擷取實際應用。`regions: [{id, box: {x,y,width,height}}]` 對應 mapping；每個區域須唯一且位於 PNG 中。

adapter 模式以應用 PNG 與 regions 檢查像素及幾何；引擎無法從不透明應用表面讀取 DOM computed styles，不能將此模式的 PASS 當成逐項 computed-style 驗證。

引擎先正規化相對／file URL、編碼、`..`、symlink 與 macOS 路徑別名，拒絕以 live prototype 或 `.protoflow/versions/` 的檔案冒充應用；非 file 的不透明 URL 交由專案 adapter 處理，其真實表面仍須審查。視覺比較保留原始 PNG、side-by-side、diff 與 50% source-over overlay，不縮放、移位或裁切差異。場景參數、尺寸與狀態不符則 FAIL。verification 綁定版本、應用 fingerprint 與 artifact hashes；像素一致不代表功能或其他平台已通過。

`tests/acceptance.test.js` 使用 Node 協定／程序 fixture，涵蓋確認順序、外來 PID、崩潰、超時、未知啟動、持久化失敗與 URL 防冒充。`tests/e2e/acceptance-adapter.spec.js` 自建暫存專案，以真正 Chromium 和 Node.js Playwright runner 驗證功能與圖片契約，沒有外部專案環境變數或 skip。這些是引擎介接測試，不是 Electron、真實裝置、GitHub、Codex provider 或人工批准證據。v2 Electron driver 的原生驗收另行執行；交付仍須符合目前的獨立審查 gate。
