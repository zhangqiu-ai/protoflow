# UIKit 控制項文字校正：離線回歸（2026-10-31）

隔離 SDK 候選只驗證 driver 文字解讀與已保存觀測；本輪沒有 native 擷取、provider、正式帳號、commit 或正式驗收狀態變更。本項不修改 `native-tree.js`、collector、XCTest、比較門檻或原型；同輪獨立的尾端定位／等待判定另見 [鍵盤步驟驗證](native-keyboard-step-verification-2026-10-31.md)。

## 行為與 guards

既有 opt-in 路徑先通過 build/session/fresh-pair/bracket 驗證。只有 AX 與 UIKit identifier 各唯一、公開 button/link role 相符、螢幕 frame 四欄完全相等、公開語意來源完整，且控制項不含輸入 subtree 時，才以 `interpretUIKitCapture` 公開文字 parts 校正文字。受影響 response anchor 亦須唯一且 count=1。無障礙名稱不當可見文字；公開 UILabel／RN Paragraph／UIButton title 的真實文字仍保留。不存在預期文字、特定 anchor 或文案分支。

原 `elementText.onTextParts` 節點參照決定實際受影響 scope，包括 flattened 幾何容器。獨立 derived AX tree 只替換已驗證控制項的文字貢獻，再由原 `elementText` 重導 parent。其他 AX contributors（包括無 identifier 的 action）保持原樣，不整個改採 UIKit scope，也不搜尋刪除字串。原始樹不改；只更新 text/provenance，其餘 count、bounds、visible、enabled、interactive、editable、role 等 facts 均保留。

provenance 保留原 AX label/text/path、既有 provenance、UIKit public text path 與 control AX path。直接控制項的頂層 source 為 `currentUIKitViewTree`；混合 derived ancestor 的頂層 source 為 `derivedAXWithCurrentUIKitControlText`，逐 part 來源仍分別保留。輸入節點保留原參照，不讀其 value。受影響 requested scope 的重複、缺失或來源無法對應使整組不套用，missing-anchor 路徑也不能繞過該組失敗。沒有 probe 的預設 normalizer 行為不變。frame 精確匹配採保守失敗；未知或自繪文字不推測。

## 實際驗證

- `node --test tests/uikit-probe-control-text.test.js tests/uikit-probe.test.js tests/uikit-probe-scroll.test.js tests/uikit-probe-bridge.test.js`：61/61 PASS。
- `npx playwright test --config tests/uikit-probe-playwright.config.js`：23/23 PASS。Node Playwright 執行實際 public interpreter，沒有啟動瀏覽器或模擬器。
- fixture 移除所有 AX value/placeholder 欄位後，重跑 control Node 24/24、同一 Playwright 23/23 PASS。
- `npm run check`：185 JavaScript files syntax PASS；6 published schemas 同步；8 example/template configs PASS。
- 頂層 provenance source 明示混合來源後，受影響 Node 24/24、Playwright 23/23 PASS。
- `git diff --check`：PASS。

案例包含 icon-only、disabled、三種公開來源的可見 `Send`、link、既有 provenance、flattened、無 identifier／無公開對應 sibling action 保留、重複 AX／UIKit／response、輸入排除、role/frame/source 不符、整組失敗與 missing-anchor 共存、無 probe 預設行為。

真實 QA Home fixture 來自 JS `44f8c696f5cb2a9d8b9b437ab9036f1ba77e52e369558eb58bb443567484e729`／binary `3330d50d20a6554c7bc0cc643966379d58bc2aee79376ebf997c0e8962dcf4ce`。兩份相同 UIKit capture 在 fixture 只保存一次，保留各自 sample metadata；所有 AX value/placeholder 欄位移除，無 QA code、token 或登入 URL。這是 regression asset，不能取代新 native 驗收。

保存 Home 回歸只改 home、bar、new、composer、send、recent 及三個 recent rows 的文字/provenance；其他 facts 逐欄不變。Send 公開文字為空；同規則也忠實反映 icon-only new-chat 與 recent rows 可見日期，不能只清除 Send 而忽略其他真實差異。

初次加入 Home provenance 斷言曾 RED：保留原參照的 checkbox subtree 有兩個既有 AX text parts 未登記來源。修正為預先登記所有原 AX node paths；沒有讀 input value 或改文字規則，同一斷言後續 PASS。正式重跑、Root review、其他產品差異與 TestFlight 均不由這些離線結果證明。

## 凍結 SHA-256

- `src/drivers/uikit-probe.js`：`98dd850aefcd832f1a990022936d4c5289fab6fd6c0be5adebaf81efbde598f6`
- `tests/uikit-probe-control-fixtures.js`：`24f5010451271d5246ddc74ab48eac1e12229fa49832839232dd0b5c1b2b7a86`
- `tests/uikit-probe-control-text.test.js`：`dba44c1022ba69438a982d3a9a0a580faa45d50d22c9428a705ca02562d5ff80`
- `tests/uikit-probe-home-observation.json`：`5697faa5f697d392840fdb0911663bee1304ec9db8ae3b53975a88df33eb572a`
- `tests/uikit-probe-playwright.config.js`：`25710adcf4e1c300fa5055fd3c43e825f47adcdd3144b89ee97bb16cbcddfc00`
- `tests/e2e/uikit-control-text.spec.js`：`b8f520f7de33616ec6cf67e0eb36f76c5f19bf53f4c789d93e650d58bf8d1679`
