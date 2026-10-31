# DOM 零 clip 可見文字：隔離 SDK 驗證（2026-10-31）

本輪只修改共享 web collector 與 focused regression。沒有更動原型、凍結頁、App 無障礙、native driver、比較門檻、正式驗收狀態；沒有 native/provider、commit 或發佈。

## 原因與範圍

真實 Chromium 的 `innerText` 包含 `position:absolute` 且 `clip:rect(0px,0px,0px,0px)` 文字，即使像素完全不存在。修正按 computed CSS，而非 class、identifier、文案或 prototype expected text 判定。只支援 legacy `clip:rect(...)`、absolute/fixed、四個有限 px 數值，且 right<=left 或 bottom<=top。auto、正面積、無效 position、未知語法及 clip-path 均保留原行為，不引入 CSS/OCR 通用解析器。

`captureOnPage` 是 prototype/web/Electron 共用預設路徑，兩側沿用同一文字規則。輸入自己的 value-or-placeholder 分支保持原樣；沒有改 count、visible、geometry、enabled、role 等 facts。

## CSSOM 文字投影

在同步 `innerText` 讀取期間，使用 constructable stylesheet 及 `adoptedStyleSheets`，以純 element child 索引 selector 對確定零 clip 的 subtree 套 `visibility:hidden!important`。不新增／修改 App DOM nodes、classes、attributes 或 ARIA；原版 browser `innerText` 排版規則保留。每個實際 subtree 節點都必須 computed visibility=hidden，否則整組恢復原觀測，不作半套修正。inline important、CSSOM 不支援／拒絕皆保守保留原 text。`finally` 依原 sheet 物件與順序精確恢復清單，沒有 await 或回退為假成功。

既有 dynamic-text exclusion 原本就暫時修改 display；本輪在同一 readText finally 改為精確恢復整個原 inline style attribute（包含 priority 與 null）。本機 Chromium 對 dirty CSSOM 直接 removeAttribute 會延後重加空 style，因此先同步 getAttribute，再移除原本不存在的 attribute；無改 screenshot policy。

## RED 與 GREEN

環境：Node v24.14.0，專案 Playwright/Chromium，真 browser 執行。

- 修改 source 前，focused Playwright 5 FAIL / 10 PASS：button/parent/root 多出 clipped New chat，fixed clipped child 與 default captureWeb 同樣失敗。RED source、log、trace 已保留。
- `node --test tests/web-clipped-text.test.js`：9/9 PASS。Node guards 同樣使用真 Chromium，不以 mock CSS 取代 browser applicability。
- `npx playwright test --config tests/web-clipped-text-playwright.config.js`：16/16 PASS，包含既有 web-text/native-controls 回歸。
- `npm run check`：192 JavaScript files syntax PASS；6 published schemas 同步；8 example/template configs PASS。
- `git diff --check`：PASS。

涵蓋零寬／零高／反向 rect、正面積與部分 clip、static 無效 clip、auto／無效值／clip-path 不處理、CSSOM 不可用、inline-important 阻擋時整組保留原 text。真可見的同名 New chat 與 [style] selector 鄰居文字仍保留；普通 visibility:visible child 不能逃逸零 clip 排除。

fixed-descendant 實際 paint 負例：零 clip ancestor 內的 fixed child 指定綠底，擷取同一實際像素為白色；移除 clip 後同位置變綠。這證明本輪 Chromium case 未逃逸 clipping，不單靠 innerText 或 bounding box 宣稱不可見。

無 dynamic 的 button-only case 驗證完整 capture 前後 App DOM、inline styles、layout、pixel buffer、ARIA snapshot 及 adopted stylesheet 物件順序一致。MutationObserver callback 累加 records，連同 takeRecords 一併驗為 0，沒有把已派送 callback 漏算。

input/dynamic case 以真 Page screenshot wrapper 在 collector 完成、真正 screenshot 開始前記錄 DOM/observer；其後仍執行實際 screenshot。collector 邊界 input 與其他非 dynamic mutation=0；dynamic 原有暫時 display mutation 如實非零，DOM 與原 priority/null 最終精確恢復。已編輯 input/textarea value 刻意不同於 HTML 初值，實際文字及 capture 後值均保留，empty placeholder/checkbox/dynamic anchor 亦保留原規則。

既有 Playwright screenshot animation cleanup 會替 input 加空 style attribute，與 collector 分開記錄；本輪沒有修改它，也不宣稱含 input 的整個 capture 無 mutation。button-only 完整 capture 的 DOM/pixel 結果不能外推為所有含輸入 screenshot 無副作用。

## 證據與限制

保守支援範圍外維持原 text，可能繼續有比較失敗；沒有假裝完成完整 CSS visibility。clip stylesheet 只在同步讀取期間存在，無 dynamic 的測試確認 App MutationObserver 沒有收到 DOM 變化；既有 dynamic exclusion 仍有明示的暫時 inline-style mutation。新 SDK 仍需 Root 最終 review、重新執行正式 verification，不從本輪合成頁推論產品或 TestFlight 完成。

本機 RED／最終 GREEN 與 Node log：`/var/folders/md/ym_j5m5d2td2fd6bxfsng6_80000gn/T/protoflow-web-zero-clip-red-evidence-7dyiyjx8`。沒有刪除原始失敗證據。

## 凍結 SHA-256

- `src/drivers/web.js`：`54f4246c097ff41b708bc347b75b7b121e5e769e7d941cf1e32d1da887b7a63c`
- `tests/e2e/web-clipped-text.spec.js`：`87cf2d18e4693b86aaefc8404b55c07eafc43009f903e9bd044903ea9808aa5b`
- `tests/web-clipped-text.test.js`：`6ef014f77e4148b2ead63095e1d532a7a19db2dbec932e0f5d601a235a92d2dd`
- `tests/web-clipped-text-playwright.config.js`：`92307c998a554d575e49bcba54f9c4c3a33d3e7d00c11ce851112c8e2f3fb453`
