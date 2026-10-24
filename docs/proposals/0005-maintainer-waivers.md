# 提案 0005：維護者豁免（maintainer waiver）

| 項目 | 內容 |
|---|---|
| 狀態 | 已實作於 0.3.49（2026-10-24）；第 5 節的待決事項已由 qiuge 決定 |
| 來源 | 思玥 `docs/decisions.md`（b84d8c1）：無人在電腦前時讓 runner 繼續前進，門檻不變；qiuge 於 2026-10-24 同意需求 |
| 影響範圍 | 驗收判定（`src/waivers.js`、`src/targets.js`）、驗收 JSON 與證據、runner 事件與自動申請、儀表板核准、交付關卡與摘要、獨立審查的綁定資料 |

## 1. 背景

引擎有判斷限制、短期修不好時，例如 0.3.48 之前原生覆蓋層的閱讀順序，該版本無論怎麼修都會 BLOCKED，只是在消耗修復次數。目前的出路只有兩條，都不理想：

- 放寬整個層級（`tiers` 改成 advisory）：範圍太大，其他畫面的真問題也一起放過。
- `target.deviations`：平台慣例，綁定錨點而不是版本，T1 結構永遠不能豁免，也不經人工核准。

qiuge 要的是明確、範圍窄、經人核准、會自動失效的例外。

## 2. 需求（思玥轉述，qiuge 同意）

1. 一個豁免只涵蓋「一個場景 × 一個層級」，可再限定一個變體（例如 `nav.sidebar.initial` / `structure` / `ipad`）。不涵蓋整個畫面、target 或層級。
2. 綁定版本的 `manifestHash`，原型改版時自動失效；記錄原因與引擎問題的參照。
3. 需要維護者核准，透過儀表板，審查者為 qiuge。代理可以建立「申請中」的豁免，但不能自己產生已核准的豁免。
4. 處處可見：儀表板、驗收 JSON 與證據都把「附豁免通過」和一般通過分開顯示，並列出被豁免的發現；發版與交付摘要分開計數。
5. 被豁免的層級照常執行並記錄發現，只有版本關卡不看它。發現一變（例如文字差異不同），豁免就不再適用。

## 3. 設計

### 3.1 豁免紀錄

`.protoflow/waivers/WVR-<時間>-<亂數>.json`：

```json
{
  "schemaVersion": 1,
  "id": "WVR-1792900000000-1a2b3c4d",
  "status": "requested",
  "target": "mobile",
  "scene": "nav.sidebar.initial",
  "variant": "ipad",
  "tier": "structure",
  "manifestId": "git-f75a61b…",
  "manifestHash": "fa4037…",
  "findings": ["nav.sidebar: text differs …"],
  "findingsHash": "sha256(依字典序排序後的 findings)",
  "reason": "覆蓋層閱讀順序是引擎限制",
  "engineIssue": "https://github.com/zhangqiu-ai/protoflow/issues/NN",
  "requestedBy": { "kind": "ai", "name": "ai:codex" },
  "requestedAt": "…",
  "verificationId": "VER-…",
  "evidence": [".protoflow/artifacts/WVR-…/prototype.png", ".protoflow/artifacts/WVR-…/application.png", ".protoflow/artifacts/WVR-…/diff.png"],
  "decision": null
}
```

- `status`：`requested` → `approved` 或 `rejected`；已核准的可以 `revoked`。
- `findings` 從某次驗收的場景證據逐字複製（`scenes[].tiers[tier].reasons`），不能手寫。申請時必須指定來源驗收 `verificationId`，引擎從那份驗收讀出發現，並確認它的 `manifestHash` 與場景、變體、層級都對得上。
- `evidence`：申請時把那次驗收該場景的截圖複製到專案的 `.protoflow/artifacts/<WVR-id>/`，即使驗收只存在 runner worktree，儀表板也看得到。
- `decision`：`{ status, reviewer, reviewerKind: "human", at, notes, waiverHash }`（`waiverHash` 只在核准時寫入）。撤回另記 `revocation: { reviewer, reviewerKind: "human", at, notes }`。
- 同一個 target、scene、variant、tier、manifestHash 與 findingsHash 已有申請中或已核准的豁免時，再申請會回傳原紀錄（`existing: true`），不重複建立。

### 3.2 建立與核准

- **申請**：`protoflow waiver request --verification VER-… --scene … --tier structure|tokens|layout [--variant …] --reason … [--engine-issue …] --requested-by <名字>|ai:<代理>`。CLI 與代理都只能建立 `requested`；`--requested-by` 以 `ai:` 開頭時記為代理。驗收只在 runner worktree 時，引擎也會到 runner worktree 找。`waiver list` 與 `waiver show --waiver WVR-…` 唯讀。
- **自動申請（決定 C）**：修復代理判斷某個失敗是引擎限制時，把它寫進 `.protoflow/engine-limits/<CTX-id>.json`：`{ "limits": [{ "scene", "variant", "tier", "reason", "engineIssue" }] }`（修復請求的 `engineLimits` 欄位給出路徑）。runner 在下一次驗收仍 FAIL、而且同一個場景層級的 findingsHash 和修復前那次驗收相同時，替它建立 `requested` 豁免（`requestedBy: ai:<執行代理>`），記錄 `waiver-requested` 事件並發桌面通知「豁免待核准」；申請被拒（例如 T4）記為 `waiver-request-failed`。每次最多 10 筆。絕不自動核准。
- **核准**：只在儀表板「待你處理」出現「豁免待核准」，動作為 `approve-waiver` / `reject-waiver`。核准者是 `dashboard.reviewer`（不得以 `ai:` 開頭），而且必須列在新設定 `policy.waivers.reviewers` 裡（例：`["張秋"]`）。沒有設定這個欄位時，整個功能關閉，申請也會被拒絕。
- **核准的綁定**：核准寫入的 `decision` 帶 `waiverHash`，涵蓋 target、scene、variant、tier、manifestHash 與 findingsHash；之後任何一項變動，這筆核准就失效。豁免紀錄只寫在專案根目錄的 `.protoflow/waivers/`，這是唯一的正本；runner 每次驗收前把整個目錄複製到 runner worktree（先刪除舊副本），所以撤回與新核准在下一次驗收就生效。每個決定也記入 `.protoflow/dashboard/actions.jsonl`。
- **不提供 CLI 核准**，和現有的版本核准一樣只走儀表板。限制：儀表板以每次啟動的 token 和 Host／Origin 檢查擋住其他網站，但同一台電腦上能讀取面板頁面的程式在技術上仍能呼叫它。這和現有的「核准版本」是同一個信任邊界，本提案不另外加強。

### 3.3 套用到驗收

驗收在算出各層級結果後（`targets.js` 呼叫 `tierVerdict` 之前），對每個 FAIL 的必要層級尋找已核准的豁免，條件全部成立才適用：

- target、scene、variant、tier 相同；
- 豁免的 `manifestHash` 等於這次驗收的 `manifestHash`；
- 豁免已核准，`decision.waiverHash` 仍與紀錄相符；
- 這次的發現非空，而且每一條都逐字出現在豁免的 `findings` 裡（決定 A）；
- 層級是 T1–T3 且在這個 target 是 `required`（決定 B）。

適用時：

- 該層級的紀錄保持 `status: "FAIL"` 與完整的 `reasons`，另加 `waiver: { id, waiverHash }`。
- `tierVerdict` 把這個層級當成已滿足；場景狀態是 `PASS`，另加 `waived: [{ tier, waiverId }]`。
- 驗收的層級摘要（`visual.tiers.<tier>`）是關卡的觀點：被豁免的場景算通過，另加 `waived: <場景數>`。
- 驗收 JSON 頂層 `status` 仍是 `PASS`，另加 `waivers: [{ id, target, scene, variant, tier, findings, reason, engineIssue }]`（沒有用到豁免時不加這個欄位，既有驗收的 hash 不變）；驗收 hash 涵蓋這個欄位，所以版本核准也綁定了「這次通過用了哪些豁免」。
- 不適用（發現變了、不同版本、豁免未核准或已撤回、核准後被改動）時，判定與現在完全相同；同時在場景證據記錄 `waiverSkipped: [{ id, tier, why }]`，讓人看得出為什麼沒套用。

### 3.4 顯示與計數

- **儀表板**：
  - 驗收矩陣的格子分三種：通過、附豁免通過（另一個顏色並標示豁免編號）、失敗。
  - 版本卡片標示「附豁免通過 N 項」。
  - 「待你處理」列出申請中的豁免，附上那次驗收的截圖對照與發現全文。
- **證據與報告**：`report` 的場景列加上「豁免：WVR-…（原因、引擎問題）」，並列出被豁免的發現。
- **交付與發版**：
  - 交付摘要、PR 內文與 `delivery status` 分開計數「通過」與「附豁免通過」，並列出豁免編號。
  - 獨立審查的綁定資料加上 `waivers`。審查提示說明：這些發現已由維護者核准豁免，審查者仍可回報，但不能因為它們本身判 FAIL。
- **事件**：runner 每次驗收後記錄 `waiver-applied`（用到的豁免）與 `waiver-skipped`（沒套用的豁免與原因，最多 20 筆）；自動申請記錄 `waiver-requested` 與 `waiver-request-failed`。
- **autoApprove（決定 D）**：開了 `policy.autoApprove` 的專案，交付中只要有版本的驗收用到豁免，交付就停在 `BLOCKED`（`reasonCode: WAIVER_APPROVAL_REQUIRED`），直到有人在儀表板核准那份驗收（人工核准綁定 `verificationHash`）。之後交付的 `approval` 記為 `{ kind: "human", reviewId, reviewer, independentReviewId, waivers }`。autoApprove 專案的儀表板只對這種版本顯示「核准版本」。

### 3.5 失效與清理

- 原型改版會產生新的 `manifestHash`，舊豁免自然不再適用。不會自動複製到新版本，要沿用就重新申請、重新核准。
- `runner rebase` 不影響豁免：豁免綁的是版本內容，不是基底。
- 儀表板可以撤回（`revoke-waiver`）已核准的豁免；下一次驗收就不再套用。已經用它通過的驗收保留原紀錄。

## 4. 與 `deviations` 的差異

| | `target.deviations` | 維護者豁免 |
|---|---|---|
| 對象 | 平台慣例，長期有效 | 引擎限制，暫時性 |
| 範圍 | 錨點 × 層級（T2–T4），全部場景 | 場景 × 層級 × 變體，含 T1 |
| 綁定 | 設定檔 | 版本 `manifestHash` 與發現全文 |
| 核准 | 改設定檔（走程式碼審查） | 儀表板上的維護者核准 |
| 執行 | 該錨點不參與比較 | 照常比較並記錄，只有關卡不看 |

## 5. 決定（qiuge，2026-10-24）

A. **子集適用**：目前的發現是豁免發現的子集就適用。修好一部分不必重新核准；新增或改變任何一條都會讓豁免失效。

B. **開放 T1–T3**：只有 `required` 的結構、token、版面層級可以豁免。T4 視覺永遠不能豁免，即使它在這個 target 是 `required`。

C. **允許自動申請、不自動核准**：見 3.2 的「自動申請」。

D. **用到豁免的版本要人工核准**：即使開了 autoApprove，見 3.4。

## 6. 實作與驗證

- `src/waivers.js`（紀錄、hash、比對、申請、決定、複製到 runner worktree），在 `src/targets.js` 套用；runner 自動申請在 `src/runner.js`；交付關卡與摘要在 `src/delivery.js`；儀表板動作與資料在 `src/dashboard-actions.js`、`src/dashboard-data.js`、`dashboard/`。CLI 只有 `waiver request|list|show`。
- 測試：
  - `tests/waivers.test.js`：比對規則（版本、場景、變體、target、層級、發現子集、核准後改動、T4 與 advisory 不豁免）、申請與決定的驗證、重複申請、撤回、複製到 worktree、runner 自動申請。
  - `tests/e2e/anchors.spec.js`：真實 Playwright 驗收，結構層失敗 → CLI 申請 → 未核准不套用 → 核准後發現改變不套用 → 同樣發現附豁免通過。
  - `tests/dashboard.test.js`、`tests/e2e/dashboard.spec.js`：只有列在 `policy.waivers.reviewers` 的人能決定（`dashboard.reviewer` 本身不得以 `ai:` 開頭）；豁免卡片的截圖、發現與核准、撤回；附豁免通過的顯示。
  - `tests/delivery.test.js`：autoApprove 下用到豁免的版本先 BLOCKED，人工核准後合併，PR 留言與 `delivery status` 分開計數。
  - `tests/notify.test.js`：「豁免待核准」通知。
