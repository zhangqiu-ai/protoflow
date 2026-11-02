# UIKit image 與 icon 可見文字校正驗證

範圍限已啟用且通過穩定取樣驗證的 UIKit 補充觀測。基底為隔離 SDK commit `63a1384f96f924b5b6ecf6431b8648f70408325b`；不改預設 native-tree、App、探針、schema、CLI、role/count/visible 事實或驗收門檻。

## 原因與規則

AX image 的 label 是無障礙名稱，原 leaf fallback 卻把它作為可見文字；既有 button/link 校正沒有涵蓋 image。現在只對 AX image leaf（沒有 AX children），在唯一 ID、原 exact frame、可信語意、無 input、肯定可見且實際 subtree 可確認時加入 image 文字校正。current role 必須是 other、button/link traits 均為 false；語意衝突、flattened sibling 推斷、重複或缺失 scope 仍拒絕。AX leaf 對應 UIKit 圖片內的真 UILabel／RN 文字不刪除；AX label 與原始證據保留。沿用既有 control provenance 名稱，不代表推導 image 角色或互動性。

另有已觀測的 nested-scroll 子樹在 interpreter 中為 visible=false，但舊候選收集把其空文字當成可校正資料；替換該 subtree 後，一個 requested 後代無法映射，導致整組 atomic 校正拒絕，連同原本已確認的 icon-only button。修正只排除沒有肯定可見性證據的候選，不降低 atomic 驗證或將未知文字清空。

## 重複執行

```sh
node --test tests/uikit-probe-image-text.test.js tests/uikit-probe-control-text.test.js tests/native-control-text.test.js tests/uikit-probe-scroll.test.js tests/uikit-probe.test.js tests/uikit-probe-bridge.test.js tests/ios-driver.test.js
npx playwright test --config=tests/uikit-probe-playwright.config.js
npm run check
git diff --check
```

新增 Node 案例涵蓋 image alt、真 UILabel／RN 字元、current button/link/checkbox/radio/switch 衝突、缺少語意、不可確認可見性、input subtree、非自有 sibling caption、重複識別碼、frame 與祖先歧義、response role 衝突，以及不確定子樹不能阻斷已確認 icon 的回歸。

`tests/fixtures/uikit-image-icon-observations.json` 保存三個 QA image/icon 的原始 AX 與 UIKit 分支及來源檔案雜湊，放入合成 validation envelope 重播；沒有保存帳號或 Profile 個資。這些分支驗證推導函式，不冒充新的 native capture。真實 Profile 字元以公開 RN Paragraph 正例及真瀏覽器可見文字驗證。

## 實際結果與限制

- RED：新增 Node 23 項中 5 FAIL；新增真瀏覽器 Playwright 4 項中 3 FAIL。錯誤確實是 image／icon AX 名稱被當作可見文字，並非定位或測試啟動失敗。
- 初版 GREEN：Node 100/100、Node Playwright 27/27（含 4 項真瀏覽器測試）PASS，原始結果保留。
- 獨立審查補出 AX image 有 caption child A、UIKit 有真 caption B 的負例：初版只把 image 自身改成 B，祖先仍為 A。新增 Node 與真瀏覽器測試均先可靠 RED；最小 leaf guard 後重跑受影響 Node 48/48、Node Playwright 28/28（含 5 項真瀏覽器測試）PASS。這類 AX image 有 children 時不做新 image 校正，整份 image 與祖先文字／provenance 保留原值；不擴張祖先重寫演算法，也不改 button/link 流程。
- 瀏覽器實際驗證 `<img alt>` 的 accessible name 保留、innerText 為空；同 scope 的真實 caption 與 button 的實際字元仍保留。原生側使用相同 public text interpreter 及保留的 observed branches。
- 本輪 native case、provider、官方 App／VER 驗收皆 NOT_RUN。沒有修改 Swift 或全域 native-tree；原始 AX、current UIKit capture 與 response 輸入保持不變。

RED/GREEN 原始記錄與來源雜湊位於本機 `/tmp/siyue-sdk-rendered-text-jld6619n/`；這些 host-only 結果不取代後續由 Root 協調的 native 驗收與獨立審查。
