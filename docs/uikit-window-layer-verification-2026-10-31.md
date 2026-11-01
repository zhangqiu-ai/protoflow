# UIKit 整窗文字的實際圖層順序

隔離基底為 `1cf809393cec372d962caceee4d9dfd745dd8be1`。本次只修正 opt-in UIKit interpreter 的整窗文字順序；不改 App、原型、AX 預設解讀、pair validator、探針、Swift、tiers、dynamic 規則或門檻。

## 規則

雙欄介面可將側欄與 popup 都放在匿名全窗 UIView 中。只按 wrapper 的 x 座標遞迴讀文字，會把最後疊上的 popup 排到右側主區前；直接攤平全部文字又會把側欄底部設定插進主區標題。兩種方式都沒有忠實保留 pane 與圖層的關係。

新增 `layeredSubtreeText` 只供目前 UIKit `facts(screen:true)` 使用：以真實 window root 同時作 tree／container，開啟 `textWithin` 的 `includeContainerDescendants`。該參數預設 false，所有舊 caller 不變。新入口只以原 `subtreeText` 的完整真實 parts 為輸入，沿用正規化後的文字／控制項／scroll／visibility 規則；geometry 不再以 frame centre 或 accepted-set 減少 parts，只使用既有 `layers` 的真實 parent、tree order、Text／scroller extents 排圖層，每層保留 pane 內順序。`stacked` 的原預設仍是 `readingOrder`。沒有建立假 root、frame、role，或使用產品 ID／文案分類。

文字 parts 保留原節點參照及公開來源 paths；輸入值、placeholder、redacted subtree、不可呈現文字不加入。背景文字不因 overlay 被丟棄；`occlusion` 仍為 notComputed。非 screen 的 UIKit scope、`elementText`、`subtreeText`、AX／幾何／角色及 raw capture 不改。

## 可重複驗證與結果

```sh
node --test tests/layered-subtree.test.js tests/uikit-partial-window.test.js tests/uikit-window-layers.test.js tests/uikit-screen-scope.test.js tests/native-keyboard-steps.test.js tests/uikit-probe-other-text.test.js tests/uikit-probe-image-text.test.js tests/uikit-probe-control-text.test.js tests/native-control-text.test.js tests/uikit-probe-scroll.test.js tests/uikit-probe.test.js tests/uikit-probe-bridge.test.js tests/ios-driver.test.js
npx playwright test --config=tests/uikit-window-layers-playwright.config.js
npx playwright test --config=tests/uikit-probe-playwright.config.js
npx playwright test --config=tests/uikit-screen-scope-playwright.config.js
npm run check
git diff --check
```

- RED：10 項 generic Node 中 8 FAIL；3 項真 Chromium DOM 對照全部 FAIL，原因均為 Sidebar → popup → main 的錯序。2 個無 popup／普通 nested 正例當時已通過。
- 初版候選 GREEN：同場景通過；加入直接 API／原節點參照／不讀 input getter guards 後，受影響 Node 同輪 **203/203 PASS**。Node Playwright 三組 **10/10、33/33、2/2 PASS**；其中新 3 項是真 Chromium `innerText` 對照。此候選隨後因下述 P2 退回，不能當作已批准交付。
- 持久案例涵蓋非重疊欄、普通 nested／空 wrapper、多層 popup、below-fold scroll、hidden／alpha0／zero clip、redacted input、錯誤實際文案保留，以及既有 ambiguous flattened scope 拒絕。未降低舊測試或 golden。

舊實際 share capture pair 仍由原 validator 通過；另存原 frame reparent 與兩層 full-window wrapper 的**純 UNIT 假說**，未冒稱新 capture。新 interpreter 對 baseline 及兩個模型均保留 Sidebar → main → overlay，且不增刪文字。預設 AX `elementText` 未改，所以 full-window 假說的 AX 原錯序仍保留。舊模型與 SHA 均未覆寫。

新差量的命令、原始 logs、模型、hash 與 patch 在 `/private/tmp/siyue-sdk-window-layers-a9sf1j20/`；舊模型在 `/private/tmp/siyue-owned-overlay-reparent-unit-wiej0jia/`。這些是 render model UNIT／DOM 證據；新 App Native、完整 207 場及正式產品驗收皆未由本記錄證明。

## 獨立審查 P2：部分可見文字不得被二次幾何篩掉

初版 manifest `08c1f11d9af85446565a258b24f9e249862c18d949ec15277b050a6f77bfd121` 與原 patch 保持不變。獨立審查以通過原 pair validator 的 frame `{-600,220,800,24}`、正 clip `{0,220,200,24}`、`renderEligible=true` 找到可靠反例：原 subtree 保留 `Partly visible`，初版卻因文字中心在 window 外而將它刪除。

先重跑 reviewer 原 script 得到 exit 1，再將新 opt-in 分支改為從完整原 hierarchy parts 建立 owner／scroller／parent／order 與 layer map；不經 `within`／accepted-set。舊 default-false body 恢復原碼。原 script 隨後 exit 0；四側 positive-clip 持久 Node 先 4 FAIL／4 guards PASS，再 8/8 PASS，四側真 Chromium 先 4 FAIL，再同 script 4/4 PASS。保留真 frame／clip／render flags、原 evidence paths、zero clip／hidden／alpha0／redacted input 的拒絕規則。

P2 後受影響 Node **211/211 PASS**；Node Playwright **14/14、33/33、2/2 PASS**。本輪沒有重複計作新場景的 Native 驗收。新差量、P2 前精確檔案、原 reviewer RED、完整 logs 與獨立 manifest 位於 `/private/tmp/siyue-sdk-window-layers-p2-yx96g8wh/`；仍待 Root fresh review，不沿用初版 NoFinding 或批准狀態。
