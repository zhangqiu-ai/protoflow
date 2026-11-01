# UIKit probe 之前的一次 AX 準備

2026-10-31；隔離 SDK 基線 `79a6c5c326cd5835518958fcbf3ec62c690f33f2`。本候選只在既有 `job.captureProbe != nil` 路徑增加一次 `app.snapshot()`，位置為原 0.3 秒 layout settle 後、原 before probe 前。準備 snapshot 立即捨棄；成功後另存 `raw.json.accessibilityPreparation = {method, count:1, startedAt, finishedAt}`，不保存準備 snapshot 的 tree、label 或 value。預設無 probe 路徑不增加 snapshot。

原 before sample → measured AX snapshot → screenshot → keyboard query → after sample 的程式與時間欄位保留；沒有重試、額外等待、空節點豁免、產品 identifier／class 特判或比較門檻變更。準備失敗仍由原 XCTest 錯誤路徑處理，不開始 measured probes，也不記錄成功的準備 metadata。準備 metadata 不能代替 measured `probeTiming`。

## 已觀測的原 App 診斷

原 immutable App 的 JS SHA 為 `2a43ce8ba1cb81aaeffbb0d742617421d191618ada2a81953e83ba563c2c1598`，executable SHA 為 `e21daade6777781f5ceb599335e397b84b3156fbad3b17bc7cc3a3c255dafe6f`。四組均為獨立 fresh launch、各執行一次；八份樣本身分一致。每組補足固定 1000ms 干預窗，操作均未超時；實際總窗約 1002–1005ms。

| 干預 | before → after 節點數 | 完整 capture 相等 |
|---|---:|---|
| 無 AX／截圖查詢 | 301 → 301 | 是 |
| 一次 AX snapshot | 301 → 302 | 否 |
| 一次 screenshot | 301 → 301 | 是 |
| AX → screenshot → keyboard | 301 → 302 | 否 |

兩組差異皆只有同位置新增一個空白 44×44 `_UIVisualEffectContentView`，完整差異含 nodeCount、parent children 長度及新增 node。這是該 App／組態的一輪控制診斷，不能延伸成所有 UIKit getter 或 AX 的普遍因果結論。只有完整組適用原 `validateProbePair`，其實際結果維持 `NOT_RUN: current tree changed during capture`；其餘組不補造不存在的 AX／截圖時戳。

完整外部證據為 `/private/tmp/siyue-original-ax-matched-arms-27snxjfz/four-arm-manifest.json`，SHA `3a87a8e6cf6ee29794606baae7196bd41cd9adc2c8cc98fe86854f54bb290eaa`。原先外部 job 缺少 `launchPreparation.timeoutMs` 的失敗也獨立保留，沒有當成 App finding 或補造數值 exit code。SDK、App、原 probe／validator 與診斷 source bytes 未修改。該診斷先於本候選，不能證明加入準備後已通過 Native 擷取。

## 本候選的可重複驗證

- `node --test tests/uikit-probe.test.js tests/uikit-probe-bridge.test.js tests/ios-driver.test.js tests/ios-launch-preparation.test.js tests/ios-public-input-replacement.test.js tests/ios-responsive-driver.test.js`：57 PASS。新增反例仍拒絕 measured pair 之間新增的匿名空 child；準備 timestamps 不能替代或修復 AX／截圖 bracket。
- `npx playwright test --config tests/launch-preparation-playwright.config.js --grep 'probe accessibility preparation'`：原 SDK79 缺少準備 metadata 時 RED；相同測試在修改後 GREEN，1 PASS。Runner 編譯並執行從真正 Swift source 擷取的 capture 排程片段，使用 Foundation shims，核對 probe 與預設順序、prep error 不開始 measured probes，以及 metadata 只含四個允許欄位。附件保存實際片段、編譯 log 與 protocol observations。
- `npm run check`：213 JavaScript 檔案、6 schemas、8 configs 通過靜態檢查。

Foundation shims 只證明 protocol／排程，不執行 XCTest、UIKit 或 Simulator，不是 App Native、真機、T1–T3 或產品驗收。原 measured block、requestProbe、launch preparation helper、公開輸入處理及 validator／native text 的 bytes 另行核對保留。候選的真 App Native 擷取與穩定 302 → 302 結果仍為 **NOT_RUN**，待 Root 審查及另行執行。


## Root 的原 App 後續 strict capture

2026-11-01 02:40 UTC，Root 在同一 immutable Siyue App（JS `2a43ce8ba1cb81aaeffbb0d742617421d191618ada2a81953e83ba563c2c1598`／binary `e21daade6777781f5ceb599335e397b84b3156fbad3b17bc7cc3a3c255dafe6f`）執行一次 `ai.home.initial` 原公開 driver。新 drivers source 正常產生新 capture cache；沒有重用舊 `6df…` Swift binary。driver PASS，只有一個 probe pair；準備 metadata 為一次 `XCUIApplication.snapshot`，完成時間早於第一份 sample 開始。前後完整 capture 相同，nodeCount 302→302；原 pair validator（整檔 SHA-256 `b90eba5ff6693258e3090b5b1cabc9aa4c6dc9f320a731f3a69ec8b20e3bc04f`）PASS，current tree hash `708e7744f294820d8dc6eca351a009416956632f8ad295450fed6638ef752467`。

Root 檢視真實 screen.png，App source 與 binary 保持原值，候選 Swift 為 `23fe64d6287a12338a03c8a2d1764a32274da8e2305203f2a59d62d5b165ba7c`，原 measured block／helpers／validator 保持。原失敗、四臂、先前 candidate manifest 與所有 RED／GREEN 保留。此為修正後單場 strict native diagnostic，不是整體 Siyue normal／responsive／provider／發佈驗收。

證據：`/private/tmp/siyue-ax-prepared-home-root-native-20261101/root-strict-native-proof.json`，SHA-256 `05ede21b9d3ec5285fb4262166d6b916126882357372f77c079ed1e916a926a6`。自有 controller 5247 已結束，沒有額外重試或 provider 呼叫。
