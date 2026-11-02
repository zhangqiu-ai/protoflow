# UIKit 正式配對前的有界靜默觀測

2026-11-01；隔離基線 `16ded197618282c92129c94434139a6a8e190060`。此變更只作用於已授權的 capture-only UIKit probe，不新增 CLI／target config flag，不修改 App collector、公開輸入或一般無 probe 路徑。

SDK driver 在原有一次 AX preparation 後、正式 `before` 前，將 optional job 欄位 `captureProbe.settleBeforeCapture` 設為 `true`，並要求獨立 `settle` phase。Bridge 最多取 8 個 fresh samples，sampling/readiness 共用 6 秒 monotonic deadline。至少 3 份完整 capture canonical hash 連續相同，且 App sample 與 host monotonic 觀測的靜默跨度都達 1500ms 才放行。直接使用未帶此 optional 欄位的舊 client 維持原排程。

每次身分查詢及 protocol IO 受剩餘 deadline 限制；不得排除 indicator、caret、class、空節點或任何欄位，也不等待整張 PNG 相同。晚到結果不能繼續 readiness。到期仍保存 `NOT_RUN` 診斷與錯誤 ack，不提高原 Swift handshake 或 outer timeout。6 秒限制 sampling/readiness，不能解讀為所有不可取消 OS IO 已物理停止。

## 正式證據保持獨立

- 每份準備觀測以 `probe-settling-<index>-<UUID>.json`、`0600`／`O_EXCL` 保存原 bytes。`probe-settling.json` 另存 `settlingReceipts`、`READY`／`NOT_RUN`、數量、quiet span 與 reason。
- 準備完成後重新取得 `before → AX → screenshot → after`；正式 `probe-bridge.json.receipts` 仍只有兩份全新樣本。每輪沿用 fresh session nonce，sample ID／檔案／receipt 不重用。準備期間不增加 AX 或 screenshot。
- 原 `requestProbe`、public-input block 與 `validateProbePair` 原始 bytes 保留。`uikit-probe.js` 只在原完整檔案後新增 `canonicalProbeValue`、`hashProbeCapture`、`validateProbeCapture` 的 exports，重用原 canonical hash 與 capture validation；單份準備樣本不構成正式驗收。
- 原正式兩份完整樹相等、實際 installed build、nonce、不同 sample ID、主執行緒、AX／截圖 bracket 與最長 10 秒要求不變。準備成功不能豁免正式 pair 內的變化。

## 原失敗與單場景 Native 診斷

原 BYOK 兩次失敗均保留為 strict `current tree changed during capture`；只有無 identifier 的 scroll indicator 及子節點共 5 個 scalar 改變，30 個 public IDs 自身欄位未變。這支持先調查擷取準備，不能證明所有後續變化都只是 fade，更不授權忽略該 class。原保存 receipt：`/private/tmp/siyue-byok-currenttree-preservation-mhmazpiz/diagnostic-receipt.json`，SHA `f133126f8994d42cbbdf0cf38dfe7232f114e3812983e8241924c48e773f74b6`。

Root 以同一 immutable App、原 frozen `settings.ai.managed-to-byok-filled` fixture／四個步驟及原 JIT wrapper 執行一次候選 Native；只有切換／輸入 synthetic key／離開欄位，未按 Connect／Save／Send，沒有 provider 呼叫。裝置為 owned `ProtoFlow iPad`、11-inch M5-16GB、landscape。App JS SHA `66bb88b7d74bb0d9994335ad7b89f79d99268e797e2e4f838a779c929c91821b`，binary SHA `d8e1edf77e2f0c460f840f60c4ed7bb1d9c443a6d084df86e531457c73cf8008`。

實際結果：3 個 samples 達 `READY`，App quiet span 約 1990.68ms、host 約 2003.99ms；正式兩個 fresh receipts 及原 strict validator PASS，完整 capture hash `b1302a71bc4ccea5248d845da2a982b728c756694d4c20f157a4868f43c84254`。Driver PASS、native exit 0、App termination／appearance cleanup readback 為 true；沒有補造獨立 orientation readback。

原 proof：`/private/tmp/siyue-sdk-settle-byok-runtime-8_56tslg/native-byok/proof.json`，SHA `f192a138442d6b2b664d20c89267fd4f5af853efe9407f5c5e93dcf1465c327e`。候選 4 source 與該 runtime 位元組相同。這是單場景擷取診斷，不代表產品 UI tiers、完整 207／73 場景、真機、provider、TestFlight 或共享 SDK 發布。

## 可重複驗證

新增持久資產為 `tests/uikit-probe-settling.test.js` 及 `tests/e2e/uikit-probe-settling.spec.js`。Node 使用私有 temporary channel、fake installed files／commands；Playwright 執行真正 `CaptureProbe` Decodable 宣告與 capture 排程片段的 Foundation shim，不啟動 Simulator。覆蓋預設／舊 client／opt-in／準備失敗、deadline、完整樹持續變化、錯誤身分與 sample 不重用；quiet preflight 後若正式 pair 改變仍被原 validator 拒絕。

外部候選已確認同一最終 Node test 對原 bridge 真 RED，候選 40 Node PASS／2 Playwright PASS，並完成 generic iOS Simulator compile。整合後 `npm run check` PASS（217 JavaScript、6 schemas、8 configs）；`npm test` 共 875 cases，874 PASS／1 SKIP／0 FAIL。聚焦 Playwright 為 launch／public edit menu／新 settling 10 PASS、UIKit 46 PASS、keyboard 4 PASS，共 60 PASS；這些計數不與先前候選結果相加。既有 AX 排程 shim 原本把 probe 當成 `Int`，新真正 Swift 片段因缺少 optional 屬性而真 RED；只調整 test port 型別及 legacy nil，保留原全部 assertions 與失敗 log。

```sh
npm run check
npm test
node node_modules/playwright/cli.js test --config tests/launch-preparation-playwright.config.js
node node_modules/playwright/cli.js test --config tests/uikit-probe-playwright.config.js
node node_modules/playwright/cli.js test --config tests/native-keyboard-playwright.config.js
```

Foundation／Node Playwright 的成功不代替 XCTest／UIKit 或產品驗收；不重跑未變的完整 SDK browser、Electron 或真 Android 套件。沒有版本提升、commit、push、shared install 或 publicSelect 候選改動。

本輪整合前後雜湊、原排程 shim RED、全部實際 log、13 個 owned paths 與精確 patch 收束於外部 `/private/tmp/siyue-sdk-settling-integration-sqvi1thk/`。原 BYOK strict 失敗、2e182 外部候選及 Root 單場景 Native proof 均未改寫；原 public-input SHA `c1968a4b0812b86fa3668bf030a70c9a509d2e060687b1c5c91e18e118d7cbfb`、launch helper SHA `b277bcaa83e1cd53641fbc5a64f196e9a80bb654cb7ed693e052dda523a877fc` 保留。此刻僅準備本機變更，尚未 commit／版本更新／shared install。
