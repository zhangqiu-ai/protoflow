# UIKit capture probe 單場景驗證（2026-10-31）

本記錄只證明隔離候選的 capture-only RN／UIKit 觀測與 driver，並非產品 tiers、AI 流程、完整場景或 TestFlight 完成。基底為 `379bd862cc5ed1a9a11c778a5e94b908225b6401` 加本次候選變更；實際來源雜湊由 run manifest 綁定，沒有由本代理建立 commit／push。

## 實際證據

- 修正後 run：`1433c9a0-02ce-4194-8827-7c0faf3c6f9a`，位於 `/Users/feature/.codex/worktrees/protoflow-native-control-text-ya7uxi/native-probe-proof/actual-rn-runs/`。
- `verified-observation-receipt.json`：完整原生／AX／建置／時間／語意／scroll／text-parts 路徑收據。
- `manifest.json`、`request.json`：實際 argv、來源雜湊及從凍結 CTX 抽取的 requested anchor IDs；沒有預期文字作為觀測輸入。
- `capture/uikit-probe-HKGWKC/probe-before.json`、`probe-after.json`：兩份未改寫原生 JSON；`probe-bridge.json` 保存複製雜湊及當前容器／已安裝 App 身分；`probe-validation.json` 保存穩定樹雜湊。
- `capture/raw.json`、`device.png`：原始 AX 與完整裝置截圖，與原生資料分開；`screen.png` 只是既有 safe-area 裁切。
- `capture/uikit-probe-HKGWKC/xcodebuild.log`、其下 `protoflow-ios-Ew7ujM/capture.xcresult` 與 run 根目錄的 `xcresult-summary.json`：XCTest 1/1 PASS、0 failures、0 skipped；不是單憑 driver exit 0 判定。

## 實際觀測

裝置為專用 `ProtoFlow iPhone 17`（iOS Simulator 27.0，`29E6F823-9B1F-4201-A8E3-9F06316CCD87`），場景 `growth.goal.task-new`。App 為 `app.siyue.mobile`，0.0.1 build 10，RN 0.86.3。collector 原始碼及 generated copy SHA-256 均為 `34a45f3ca7fbd7811b15d7dbe80cdbdc6957f7d848f7734772ab14d27c6c91e4`。

- 171 個原生節點，36 個真正 `RCTParagraphComponentView.attributedText` 節點；原始 AX 有 19 個節點、35 個 requested 背景 anchors 在 AX 中均不存在。沒有改 modal 的 AX 隔離。
- 根節點仍是真正 `UIWindow`，`attachedToWindow`、`renderEligible`、`isSelectedOwnedWindow` 為 true，當前 windowScene 為 foreground active，scene session 與 window 記錄相同，screen 文字非空。
- 兩次 fresh sample ID 不同，同一 nonce/context/scene/build，完整當前樹雜湊相同：`69750f292606746ffefffc0c2960474f4580612ca9f1dc5a9dce7c4147ea6ed5`。原 AX 及截圖的時間順序完整落在 0.508152 秒 bracket 內，bridge 複製收據順序及位元組雜湊也獨立核對。
- 可執行檔 SHA-256：`6c406229b4196f57bc0bc850978d2ff729fd01403fd9bd00f59ec537f0b3e3e7`；main.jsbundle SHA-256：`c1ea123e482d6fa64d87d01a34b72e8fd5ad109978def594b9ed6627776b1a8b`。來自實際已安裝檔案，與 App 自行回報的 actualBuild 完全相符。
- back／more／plan／tasks-new／task rows／discuss 實際讀到 `buttonTrait=true`、RN `accessibilityRole=button`、`disabled=false` 及有效 UIKit interaction；每欄標記公開 getter 來源。這一場景沒有冒稱觀測到 RN checkbox／radio。
- modal 的 `RCTUITextField` 只輸出公開 enabled／editable／type 結構 metadata，輸入文字為空，沒有 value、label、placeholder 或 children。輸入內容並未讀取，兩棵樹相同不代表輸入值穩定性證明。
- `chart.note`、`ai-note`、`discuss` 的原始 `renderEligible=false`、零 `clipIntersection` 保持不變；根據實際單一 UIScrollView geometry，另有 `scrollContentEligible=true` 及 `observedScrollContentOutsideViewport` 原因。沒有把它們描述為 viewport 可見或新增 mask。
- `ai-note.children=[]` 原樣保留。其文字依既有 `elementText/textWithin` 同層幾何規則取得三個真實 RN Text parts，provenance 明記 `flattenedSiblingGeometry` 與完整原生 node paths，沒有假造 descendant ownership。`chart.note` 與 `discuss` 則使用各自實際 subtree。

## RED、回歸及範圍

首輪 run `2437ea5a-ffe7-4c2f-ae16-41993405c831` 保留所有原始資料及 `adjudication.json`：當時 `UIWindow.window == nil` 被誤判為 detached，導致 screen 文字空白。修正使用當前已選中、foreground-active 的真正 UIWindow binding；validator 新增拒絕無效 root 的回歸，不沿用首輪 transport PASS 作為正確觀測證明。

`offline-test-receipts.json` 是實際工具輸出的摘要收據（不是重建的 raw log）：Node 53/53 PASS、相關 Playwright 7+3/10 PASS，包含 chart 高度改變仍觸發像素／感知失敗的負例。覆蓋 nonce/build/time/replay、私有檔案通道、真實檔案雜湊、input redaction、公開語意、disabled、AX 保留、local clip、hidden/alpha/detached/zero、nested/transform、modal 分層及歧義幾何。`native-tree` 新增的 `onTextParts` 只回報原算法最終選中的文字節點，預設判斷及回傳不變。

本輪只執行 synthetic QA wrapper 與專用 simulator，沒有模型／付費服務或正式帳號請求。未改 shared engine、凍結原型、門檻或 waiver。正式 EXEC trace、全量場景與最終 source／build 重新驗證由 root 後續執行，不回填或虛構交付 provenance。
