# 非輸入 other AX leaf own-text 驗證

基底是 image leaf P2 修正後的隔離來源，`uikit-probe.js` SHA `eba47967acc2cce7bd23e6a3a1b9368dc118b14abe748bde6670f803ccde7a19`。本次只擴充 opt-in UIKit 文字校正；先前 image P2 的來源、RED/GREEN 及審查證據另保留於 `/tmp/siyue-sdk-rendered-text-jld6619n/`，沒有覆寫。

## 原因與受限規則

實際 avatar 的 AX 名稱是帳號名稱，但目前 UIView 中有真正顯示的 RN Paragraph 字元。parent profile 的現有 button 校正已保留該真字元；avatar own fact 卻仍沿用 AX 名稱，使 T1 動態文字排除使用不同的片段。修正必須校正 own fact，不能刪除真字元或改 T1。

新分支只接受非輸入 other AX leaf，且滿足唯一 AX／UIKit ID、原 exact frame、可信 semantic role=other、button/link traits 均 false、沒有 input／editable metadata、肯定可見、subtree scope、非空且非純空白文字。每個 public Text part 必須來自既有公開文字來源，且其原生 path 實際位於該 UIView 的 own subtree。AX image 後代一律不加入這個分支，以保留既有保守圖片邊界；有 AX children 的 other 不修正。未知、空容器及 sibling 幾何文字都不能清除 AX 名稱。

已校正的 parent button 可能以自己的 public text parts 取代其 AX 子樹，因此不再保留原 other leaf 的 derived node。僅此已完整對應、擁有非空 public parts 的 other leaf 可直接記錄 own fact；不補造 disconnected AX geometry，不放寬 button/image 的 derived-node 檢查。所有受影響 requested scopes 的原 text、count、唯一 ID、role、input 與 atomic 檢查維持原樣。原 AX 名稱、原始快照及先前 provenance 保留；只改 text/provenance。

沒有變更 native-tree 預設、UIKit 探針、角色／count／visibility 事實、schema、CLI、tiers、動態排除或門檻。control function／provenance 名稱為向後相容保留，不表示把 other 推導為控制項。

## 可重複回歸

```sh
node --test tests/uikit-probe-other-text.test.js tests/uikit-probe-image-text.test.js tests/uikit-probe-control-text.test.js tests/native-control-text.test.js tests/uikit-probe-scroll.test.js tests/uikit-probe.test.js tests/uikit-probe-bridge.test.js tests/ios-driver.test.js
npx playwright test --config=tests/uikit-probe-playwright.config.js
node --check src/drivers/uikit-probe.js
git diff --check
```

`tests/fixtures/uikit-avatar-own-observations.json` 保存 nav.me.initial／settings.home.managed 的實際 avatar AX／UIKit 分支、parent 公開語意及來源 SHA。唯一帳號名稱欄位明確遮罩；UIView 的 geometry、traits、真實 Paragraph 字元不改。這些分支放入合成 parent validation envelope，不能當作新 native capture。完整未遮罩的原始證據繼續留在既有私有 Main artifacts，沒有納入 SDK。

新增正反例涵蓋 RN／UILabel／UIButton 公開文字、parent button 已替換子樹、原 provenance，以及空／純空白／僅 accessibility label、衝突 traits／roles／input／editable、未知可見性、隱藏文字、AX children、image 後代、重複識別碼／response、frame／ancestor／role／inputType／原 text 歧義和不屬於自身的 sibling 文字。

## 結果與限制

- RED：新增 Node 34 項中 7 FAIL；真瀏覽器 Playwright 5 項中 4 FAIL，失敗是 own fact 仍為 AX 名稱，並非啟動或定位問題。
- GREEN：受影響 Node 135/135、Node Playwright 33/33（含 10 項真瀏覽器測試）PASS。原 image-with-AX-caption P2 負例、image leaf 真 caption、button/link 與真 Profile 字元正例均保留。
- 已完成的 Main 舊 artifacts 另以 SDK validator 離線重播：兩場 avatar own fact 對齊真字元，parent 真實文字不變；原 raw、current UIKit、response 輸入及非 text/provenance 事實不改。
- 舊 settings.home.managed 的離線 structure finding 由 2 變 0；舊 nav.me.initial 的 profile finding 消失，但 root 仍有一條 Z 差異，原 reason 保留。沒有硬刪文字或修改 comparator；後續新原型 hash 仍需 Root 重新驗證。
- native、provider、官方 App／VER 驗收 NOT_RUN。Swift 未改，未重跑無關原生編譯。

本次獨立命令、來源 SHA、完整 incremental／cumulative diff 與原始 log 位於 `/tmp/siyue-sdk-other-own-text-k5thet7o/`。
