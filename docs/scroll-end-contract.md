# 明確的垂直捲動起點／終點

狀態：本地候選；真實 iOS 手勢／終點驗收尚未執行。一般 `scroll-to` 保持「令目標可見」。需要跨 Web／iOS 保持相同內容起點或終點的狀態，可明確指定：

```json
{ "action": "scroll-to", "anchor": "example.export", "value": "end" }
```

`start` 同樣使用 `{"action":"scroll-to","anchor":"example.first-row","value":"start"}`，指向目標所屬的唯一垂直 scroll ancestor 的內容起點；不點擊目標、不切換模式，也不以固定像素回捲。`end` 是同一祖先的內容終點，不是目標本身的 bottom 或 center。未知 value、重複 endpoint anchor（含同 anchor 的 start／end）、巢狀 scroll、水平內容或 transform 均拒絕。這個 opt-in 只由 Web 與帶 current UIKit probe 的 iOS reference driver 處理；不要交給未明確實作此語意的外部驅動器。沒有 value 的既有行為不變。

Web 直接操作真正 DOM scroll 容器，start 使用 scrollTop=0，end 使用 scrollHeight-clientHeight，並讀回真值；所有後續 steps 與 readiness 完成後，再依唯一 exact anchor 重驗當下 scroll 祖先的 scope／endpoint 及目標渲染狀態。若當下不在終點或目標已不渲染，則不報成功。

iOS 先確認唯一 exact identifier 與唯一 public AX scroll ancestor，僅在該 scroll viewport 內做至多十次公開 slow drag（start 從 20% 向 80% 向下拖，end 保留反向），受 step timeout 限制。兩次幾何不動只會停止額外手勢，**不證明終點**。OS 呼叫本身可能超過 deadline；返回後不再繼續動作，也不報 PASS。helper 將 viewport、target frame、手勢次數及 `endpointVerified:false` 存在原 raw 證據。start 額外記錄 `endpoint:"start"`；缺少 endpoint 的歷史 observation 只可用於 end，不能用來證明 start，end 的既有 raw shape 保持。

最終證明使用原正式 before/after strict pair 的真 UIKit hierarchy：目標／祖先唯一、owned window／actual build／原樹全量相等、rendered、enabled、無 transform，且原手勢 viewport/target frame 與當前量測吻合。起點為 `minimum=-adjustedContentInset.top`；終點為 `max(minimum, contentSize.height - bounds.height + adjustedContentInset.bottom)`；要求 contentOffset.y 達到所選真值。四個 inset 只要求 finite，合法負 top 仍依數學 min 計算，不能假定 native minimum 為零。精度為一個實體像素，不修改畫面比較門檻。必須由 collector 的公開 `UIScrollView.adjustedContentInset` 提供四個 finite 值；沒有資料即拒絕，不能用 contentInset 或 AX 子節點最大 bottom 代替。

此契約只證同場背景的最終 endpoint。Web 不追蹤跨 steps 的 DOM 物件 identity；Native 以 public ID 及手勢記錄的 viewport／target 兩個 frame 關聯當前觀測，不保證跨 steps 的 native 物件 identity 或 initial extent 不變。

正式 probe session、before/after 樣本數、nonce／sample IDs、完整 hash、input redaction、background anchor 與原比較規則皆保留。沒有新增 probe phase、執行 channel、setter 或 case-specific 位移。成功的終點證據另存 `probe-scroll-alignment.json`，包含原 strict tree hash／兩個 sample IDs／真節點路徑與 geometry。其前提是原 pair 已通過驗證。

持久測試：`node --test tests/scroll-alignment.test.js tests/scroll-end-preflight.test.js tests/scroll-start.test.js tests/scroll-start-preflight.test.js`、`npx playwright test --config tests/scroll-alignment-playwright.config.js`。後者執行真 DOM 及抽取實際 Swift helper 的 mock gesture runtime，也用真 iOS Simulator XCTest/UIKit 宣告做 typecheck；它不啟動 Simulator，不能替代 Native 手勢驗收。collector 的額外公開 getter 必須由目標 App 提供；reference driver 不會注入或修改 App。

既有公開匯出 `nativeScrollEnds`／`webScrollEnd` 與 raw 欄位 `scrollEndObservations` 保留相容名稱。新增 start 只擴既有函式／step value，不新增 CLI、配置、probe phase、channel、collector getter 或產品行為。request schema 的通用 string value 已容納此值，runtime validator 仍拒未知值。新 Start 的 DOM、實際 Swift dispatch/helper mock 及真 iOS API typecheck 只證工具契約；真 Native 起點驗收仍為 NOT_RUN。
