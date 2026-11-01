# 公開編輯選單重新整理：回歸模型與證據邊界

本記錄對應原 Forward 點擊後取得一次公開 `app.snapshot()`、失敗即停止的最小候選。它不加入 Select、捲動、額外等待或輸入值記錄。本記錄區分模型、單次受控 Native 診斷及正式驗收；單次診斷不代表完整正式驗收。

先前加入多項觀測的原流程診斷已完成：兩個 Forward 後都出現唯一、enabled 且 hittable 的公開 Select All button，並完成合成標題 185 字、正文 1225 字的完整回讀、Save／鍵盤／Cancel 及清理檢查。其[本機原始證據](/private/tmp/siyue-public-menu-original-observer-native-root-20261101/evidence.json)保留為診斷資料。該觀測同時包含 snapshot、額外查詢與截圖，因此不能據此斷言 snapshot 是真正成因。

持久測試直接讀取此 SDK 的 `drivers/ios/UITests/CaptureTests.swift`，將原始方法置入 Foundation 假實作；不依賴臨時候選檔、App、帳號、pins 或操作腳本。模型刻意模擬「新公開按鈕已存在，但查詢仍停留在舊視窗，直到重新取得公開 snapshot」；這是反例模型，不是 UIKit 內部實作證據。

外部資產準備時，實際 ea34 Swift（`c1ac8cc2…`）透過相同 repo-relative 入口得到可靠 RED；兩項差異為過期視窗及新增 snapshot 拋錯分支。隔離候選 Swift（`fcbf3202…`）使用相同資產得到 Node 1 PASS、Playwright 1 PASS。這些結果及原失敗記錄分開保留，尚未以本資產重跑完整 SDK suites。

同一組 14 個條件涵蓋過期視窗、已更新的 button 分支、直接可用的 menuItem、snapshot 拋錯、無動作、重複／異父層／不可點擊的 Forward、錯誤輸入角色、清除不完整、四頁上限、secure input 零值讀取、不可到達的輸入框及永久無進展選單。Node 與 Playwright 共用同一個模型；重跑不增加獨立條件數。

```sh
node --test tests/ios-edit-menu-refresh.test.js
npx playwright test tests/e2e/ios-edit-menu-refresh.spec.js --project=chromium
```

這些測試只在 macOS 執行 Swift Foundation，不會啟動 Simulator。非 macOS 會明確略過。測試輸出保留編譯記錄、實際來源 SHA 與模型結果；不得把模型通過當作真實 iOS 選單已修復。Root 隨後完成[純最小路徑的單次受控 Native 診斷](/private/tmp/siyue-forward-snapshot-minimal-native-root-20261101/evidence.json)：公開 snapshot 路徑實際執行 2 次，其中正文 1 次，標題 185 字及正文 1225 字完整回讀、Save／鍵盤／Cancel／清理均通過。該診斷沒有選單迴圈中的額外查詢或截圖；它證明此路徑在該次實測可完成，不證明過期 AX 是唯一成因或所有時序問題已消失。正式驗收另行處理。
