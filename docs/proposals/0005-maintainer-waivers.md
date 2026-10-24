# 提案 0005：維護者豁免（maintainer waiver）

| 項目 | 內容 |
|---|---|
| 狀態 | 提案（2026-10-24），待 qiuge 確認第 5 節的待決事項後實作 |
| 來源 | 思玥 `docs/decisions.md`（b84d8c1）：無人在電腦前時讓 runner 繼續前進，門檻不變；qiuge 於 2026-10-24 同意需求 |
| 影響範圍 | 驗收判定（`src/targets.js`、`src/tiers.js`）、驗收 JSON 與證據、儀表板核准、交付摘要、獨立審查的綁定資料 |

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
  "decision": null
}
```

- `status`：`requested` → `approved` 或 `rejected`；已核准的可以 `revoked`。
- `findings` 從某次驗收的場景證據逐字複製（`scenes[].tiers[tier].reasons`），不能手寫。申請時必須指定來源驗收 `verificationId`，引擎從那份驗收讀出發現，並確認它的 `manifestHash` 與場景、變體、層級都對得上。
- `decision`：`{ status, reviewer, reviewerKind: "human", at, notes }`。

### 3.2 建立與核准

- **申請**：`protoflow waiver request --verification VER-… --scene … --tier … [--variant …] --reason … --engine-issue …`。CLI 與代理都只能建立 `requested`。代理在 runner 裡判斷是引擎限制時，也只能走這條。
- **核准**：只在儀表板「待你處理」出現「豁免待核准」，動作為 `approve-waiver` / `reject-waiver`。核准者是 `dashboard.reviewer`（不得以 `ai:` 開頭），而且必須列在新設定 `policy.waivers.reviewers` 裡（例：`["張秋"]`）。沒有設定這個欄位時，整個功能關閉，申請也會被拒絕。
- **核准的綁定**：核准寫入的 `decision` 帶 `waiverHash`，涵蓋 target、scene、variant、tier、manifestHash 與 findingsHash；之後任何一項變動，這筆核准就失效。核准紀錄與版本核准一樣，寫到 runner worktree 再複製回專案，並記入 `.protoflow/dashboard/actions.jsonl`。
- **不提供 CLI 核准**，和現有的版本核准一樣只走儀表板。限制：儀表板以每次啟動的 token 和 Host／Origin 檢查擋住其他網站，但同一台電腦上能讀取面板頁面的程式在技術上仍能呼叫它。這和現有的「核准版本」是同一個信任邊界，本提案不另外加強。

### 3.3 套用到驗收

驗收在算出各層級結果後（`targets.js` 呼叫 `tierVerdict` 之前），對每個 FAIL 的必要層級尋找已核准的豁免，條件全部成立才適用：

- target、scene、variant、tier 相同；
- 豁免的 `manifestHash` 等於這次驗收的 `manifestHash`；
- 這次的發現非空，而且每一條都逐字出現在豁免的 `findings` 裡（待決事項 A）。

適用時：

- 該層級的紀錄保持 `status: "FAIL"` 與完整的 `reasons`，另加 `waiver: { id, waiverHash }`。
- `tierVerdict` 把這個層級當成已滿足；場景狀態仍是 `PASS`，但加上 `waived: [{ tier, waiverId }]`。
- 驗收 JSON 頂層 `status` 仍是 `PASS`，另加 `waivers: [{ id, target, scene, variant, tier, findings }]`；驗收 hash 涵蓋這個欄位，所以版本核准也綁定了「這次通過用了哪些豁免」。
- 不適用（發現變了、不同版本、豁免未核准或已撤回）時，判定與現在完全相同；同時在場景證據記錄 `waiverSkipped: { id, why }`，讓人看得出為什麼沒套用。

### 3.4 顯示與計數

- **儀表板**：
  - 驗收矩陣的格子分三種：通過、附豁免通過（另一個顏色並標示豁免編號）、失敗。
  - 版本卡片標示「附豁免通過 N 項」。
  - 「待你處理」列出申請中的豁免，附上那次驗收的截圖對照與發現全文。
- **證據與報告**：`report` 的場景列加上「豁免：WVR-…（原因、引擎問題）」，並列出被豁免的發現。
- **交付與發版**：
  - 交付摘要、PR 內文與 `delivery status` 分開計數「通過」與「附豁免通過」，並列出豁免編號。
  - 獨立審查的綁定資料加上 `waivers`。審查提示說明：這些發現已由維護者核准豁免，審查者仍可回報，但不能因為它們本身判 FAIL。
- **事件**：runner 事件新增 `waiver-applied` 與 `waiver-skipped`。

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

## 5. 待決事項（請 qiuge 確認）

A. **發現變少時是否仍適用**：建議「目前的發現是豁免發現的子集」就適用。修好一部分不必重新核准；新增或改變任何一條都會讓豁免失效。另一個選項是要求完全相同。

B. **可豁免的層級**：建議只開放 `required` 層級，`advisory` 本來就不擋關卡。是否限制只能豁免 T1／T2，T3 版面、T4 視覺不開放？

C. **代理能否自動申請**：建議 runner 在版本因同一個發現連續失敗、而且執行代理標示為引擎限制時，自動建立 `requested` 並通知，但絕不自動核准。或者只允許人或 session 手動申請？

D. **對 `policy.autoApprove` 專案的影響**：建議即使開了 autoApprove，用到豁免的版本仍要人工核准版本，因為豁免是用來放行的例外，不應該再讓 AI 自動放行。

## 6. 實作與驗證計畫

- 新增 `src/waivers.js`（紀錄、hash、比對），在 `targets.js` 套用，並擴充儀表板動作與資料。CLI 只有 `waiver request|list|show`。
- 測試：
  - 單元：比對規則（版本、場景、變體、層級、發現子集或完全相同）。
  - 驗收整合：附豁免通過、發現改變後失效、未核准不套用。
  - 儀表板：只有列在 `policy.waivers.reviewers` 裡的人能核准，`ai:` 一律拒絕。
  - 交付摘要計數。
- 文件：`docs/dashboard.md`、`docs/git-runner.md`、`docs/protocols.md`（驗收 JSON）、README 功能概覽、`skills/protoflow`。
