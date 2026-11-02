# UIKit 整窗 screen 文字範圍校正

基底為隔離 SDK `c52b0bbb9c7a9afc434cbba50b60601e88846921`。本次只修正已通過穩定取樣驗證的 opt-in UIKit 文字解讀，不修改預設 native-tree、探針、Swift、pair validator、CLI、tiers 或門檻。

## 原因與規則

原生 screen anchor 可能只涵蓋主內容區，側欄則是同一 window 的 sibling。既有 screen fact 的 bounds 依完整 captured content 回報，但 AX 文字仍取主區，因此漏掉真正在畫面上的側欄。UIKit interpreter 已有 `ownedWindow` screen 解讀；舊路徑卻只在存在缺失錨點時使用它。

新校正僅適用於 AX screen frame 為 captured content 真子區的情況，要求 response／AX／UIKit screen 各唯一、count=1、AX／UIKit 原始螢幕 frame 完全相同、原 AX text 可重算一致、response bounds 符合完整 content、content 位於唯一已驗證的 owned window 內。screen 必須是非輸入、非互動的 other，公開語意、肯定可見性及非空 physical text parts 均須成立。全內容 screen、未知或衝突資料維持既有處理。

通過後，只將 screen 的 text 改為現成 interpreter 的整個 owned window 公開文字，並加入 `publicOwnedWindowScreenText`、`ownedWindow`、screen／scope path、public Text paths、原 AX text／label／path 與先前 provenance。既有 blocked control group 不可繞過；新 scope 驗證失敗也不能經由無關 missing anchor 間接取得整窗文字。bounds、角色、互動、可見性、其他錨點及原始輸入不改。背景與 overlay 沿用既有 UIKit subtree 文字順序；`occlusion=notComputed`，不宣稱已計算視覺遮擋。

實際 handle、聊天數與其他動態值照實保留。這不是文字刪除規則，也不因原型的預期值而改寫實際觀測。

## 可重複驗證

```sh
node --test tests/uikit-screen-scope.test.js tests/uikit-probe-other-text.test.js tests/uikit-probe-image-text.test.js tests/uikit-probe-control-text.test.js tests/native-control-text.test.js tests/uikit-probe-scroll.test.js tests/uikit-probe.test.js tests/uikit-probe-bridge.test.js tests/ios-driver.test.js
npx playwright test --config=tests/uikit-screen-scope-playwright.config.js
npx playwright test --config=tests/uikit-probe-playwright.config.js
node --check src/drivers/uikit-probe.js
git diff --check
```

`tests/uikit-screen-scope-fixtures.js` 是匿名合成 envelope，保留觀測到的 dock／main sibling 結構及幾何，不複製私人完整原生樹。它通過既有 pair validator 後再測解讀。既有 fixture factory 僅增加可選 content／window frame，原測試預設不變。

- 可靠 RED：新增 Node 正例 3 項與真瀏覽器 Playwright 2 項均因 main-only 文字失敗；修正 fixture live-node 引用後，最終 42 項早期集合以原 HEAD 模組唯讀 loader 重驗，仍為 39 PASS／3 FAIL。另保存真實 capture 的離線 RED。
- GREEN：既有 135 項 Node 加當時新增 42 項，同輪 177/177 PASS；其後新增 gate／provenance／handle／missing-anchor 負例，最終新集合 48/48 PASS。既有 Node Playwright 33/33 與新增真瀏覽器 2/2 PASS。計數分批記錄，不冒稱單次執行 183 項。
- 最初以 `umask 077` 跑既有 bridge 測試，使刻意建立的 0644 檔案變成 0600，造成 1 項測試環境失敗。保留原 log，恢復測試預期 `umask 022` 後同 177 項通過；bridge 及權限判斷未改。
- 中間測試 fixture 的淺複製引用及新增缺失錨點後的 immutable assertion 已修正，原中間失敗 log 保留；它們不算產品 RED。

## 真實工件離線診斷與限制

本輪 `VER-1793482364163-5d6645b3/mobile/ipad-landscape` 的 11 個完整場景，使用原始 before／after、實際 build、原 session 及未改 pair validator 重播，再使用凍結 context 和未改 `compareStructure(native=true)`。每場 6 份原工件位元組雜湊與所有既有非文字 facts 均不變。原 probe session 保持 `CTX-1793436804547-a8539580`，不能改稱外層 normal 的 context。

7 場取得新的整窗文字校正；quota、model-unavailable、unavailable、export 原本已有整窗 missing-anchor 解讀，不新增 scope 校正。11 場 T1 **仍為 FAIL**：所有場景都有原型已排除、但目前 screen contract 未給 Native 對應動態錨點的實際 handle；image ready／save-error／export 另有原型聊天數 7、實際 6 的差異。quota／export 的背景與 overlay 文字語序一致。這些差異如實保留，沒有刪除 handle、改寫 count 或降低比較標準。

`ai.image.delete-confirm` 工件未完成，明列 NOT_RUN。此處全部是既有工件離線診斷，不是新 native 執行、正式 VER、產品驗收、provider 或 TestFlight 完成。原始失敗證據未覆寫。

精確命令、輸入雜湊、原始 logs、離線 replay、來源 manifest 與 patch：`/var/folders/md/ym_j5m5d2td2fd6bxfsng6_80000gn/T/siyue-sdk-screen-scope-57fgeq1w/`。
