# 狀態與資料協定

生命週期證據記錄包含 `schemaVersion: 1`、唯一 id 與 createdAt（UTC）；鎖 owner 與 latest pointer 使用較小結構。SHA256 基於引擎輸出的 JSON 序列與檔案內容；人工編輯 evidence 會改變 hash。這是本機 provenance，不是防惡意竄改的簽章。

## 狀態鏈

```text
session.active → session.checkpointed → manifest
manifest → context → execution
manifest → verification.PASS | FAIL | NOT_RUN
manifest 依建立順序排隊；應用端只處理最早未 PASS 的版本（queue.current），其他版本 → BLOCKED
verification → review.pending → approved | rejected | changes_requested
review.approved + fresh evidence → baseline.approved
repair → READY_FOR_REVIEW | NEEDS_REVIEW
```

## 專案 evidence tree

```text
.protoflow/
├── active.lock/owner.json   # 應用端操作
├── design.lock/owner.json   # 設計端 session／checkpoint／watch
├── sessions/<id>.json       # 修改前／後的原型快照
├── versions/<manifest-id>/  # 該原型版本的凍結副本：files/ 與 index.json
├── manifests/<id>.json      # changes, mappings, L0–L3, scoped Git diff
├── contexts/<id>.json       # Context / integration / execution records
├── verifications/<id>.json  # checks + projectHash + artifactHashes
├── artifacts/<verify-id>/   # PNG 與 visual-review.html
├── artifacts/<WVR-id>/      # 豁免申請時複製的場景截圖
├── waivers/<WVR-id>.json    # 維護者豁免（正本在專案根目錄；runner 驗收前複製到 worktree）
├── engine-limits/<CTX-id>.json # 修復代理標示的引擎限制（在 runner worktree）
├── operator-actions/<CTX-id>.json # 執行代理宣告需要操作員修改的檔案（在 runner worktree）
├── handoff/<CTX-id>.json    # 執行代理留給下一輪修復的交接筆記（在 runner worktree）
├── reviews/<id>.json        # 人工決定、finding、證據綁定
├── repairs/<id>.json        # bounded attempts, blockingReason
└── baselines/
    ├── <id>.json            # UI 版本關係，不是單張 screenshot
    └── latest.json
```

接入專案應將 `.protoflow/` 加入自己的 `.gitignore`；`init` 保留既有忽略策略，沒有自動編輯 `.gitignore`。如需版本化 Baseline metadata，接入專案應明確選擇保存／移交方式，不自動把大量 screenshot 加入 Git。

## Change Manifest

```json
{
  "schemaVersion":1,
  "id":"manifest-ID",
  "sessionId":"session-ID",
  "beforeHash":"PROTOTYPE_BEFORE_SHA256",
  "afterHash":"PROTOTYPE_AFTER_SHA256",
  "level":"L0",
  "summary":"Reduce input height",
  "changes":[{
    "path":"prototype/chat.css",
    "type":"modified",
    "beforeHash":"FILE_BEFORE_SHA256",
    "afterHash":"FILE_AFTER_SHA256",
    "level":"L0",
    "mappings":["chat-input"],
    "diff":"--- a/...\n+++ b/...\n..."
  }],
  "mappings":["chat-input"],
  "git":{"available":true,"head":"COMMIT_SHA","status":"...","diff":"..."},
  "review":{"required":true,"status":"pending"}
}
```

`changes.type` 支援 added／modified／deleted。binary 僅內容 hash，不假裝有文字 diff。snapshot session 包含精確內容，Git HEAD 只作額外追蹤，未 commit 的修改仍可驗證。

## Verification 與 Review

verification 包含 manifestId/hash、prototypeHash、project（全檔 hash 集）、Git HEAD、build/functional exitCode/stdout/stderr、visual scene/mapping checks、artifactHashes、changedDuringVerification，以及 hygiene。修復輪的驗收可帶 `reused`（重用上一次 PASS 的 build 與場景，各場景 `reusedFrom`）、`reuseSkipped`（不能重用的原因）與 `partial`（先擷取的失敗場景仍失敗時，其餘場景 `skipped`、`NOT_RUN`）；有 skipped 場景的驗收不會 PASS。PASS 要求三種驗證全 PASS，mapped changes 全覆蓋，產品內容在 acceptance 期間穩定，且 hygiene PASS。

`hygiene` 檢查被綁定的應用內容是否像工具快取或下載：Git 尚未追蹤的應用檔超過 1000 個，或任何應用檔超過 25 MiB，即 FAIL，`reason` 依目錄列出數量與大檔。實測中執行代理因沙箱不能寫入 `~/.gradle`，把 `GRADLE_USER_HOME` 設在 worktree 內，26,437 個快取檔被驗收並寫進交付 commit；此檢查讓它在驗證階段 FAIL，並在修復時把原因交給執行代理。git 忽略的檔案不屬於應用內容，不計入。非 Git 專案只檢查檔案大小。

**維護者豁免**（[提案 0005](proposals/0005-maintainer-waivers.md)）：v2 錨點驗收在算出場景各層級後套用已核准的豁免。適用的層級（只限 `required` 的 `structure`、`tokens`、`layout`）保持 `status: "FAIL"` 與完整 `reasons`，另加 `waiver: { id, waiverHash }`；場景加 `waived: [{ tier, waiverId }]` 並可以是 `PASS`；`visual.tiers.<tier>` 摘要以關卡觀點計算，另加 `waived: <場景數>`。不適用的豁免記在場景的 `waiverSkipped: [{ id, tier, why }]`。用到豁免時，`visual.waivers` 與 verification 頂層 `waivers` 列出 `[{ id, target, scene, variant, tier, findings, reason, engineIssue }]`；沒有用到時不加這個欄位，所以 verification hash 與之前相同，而人工核准綁定 verification hash，也就綁定了「這次通過用了哪些豁免」。豁免紀錄的欄位見提案 3.1。

Review 包含 status、reviewer、reviewedAt、notes、findings、manifestHash、verificationHash、projectHash。finding 範例：

```json
[{"id":"F-001","component":"chat-input","severity":"high","description":"Enter key behavior differs from prototype","resolution":"pending"}]
```

以 `--findings relative/path.json` 傳入 finding array；severity 支援 critical／high／normal／low。pending review 可記錄失敗或過期 evidence；approved 則一定重新核對 PASS 與內容 freshness。批准之後再改 app、config、spec、ADR、prototype、screenshot 都需重新驗證。

## UI Baseline

Baseline 包含 parent、manifestId/hash、reviewId/hash/reviewer、prototype hash/Git、application hash/Git、verificationId/hash、spec/adr path/hash、changed mappings、scene 結果與 artifact references。未 commit repository 的 Git commit 可以是 null，內容 hash 仍精確。latest 指向最後建立的節點，現有節點不覆寫；初版 CLI 建立線性 chain。

IDs 是引擎產生的時間戳加 UUID 片段，checkpoint 次數不增加正式 SemVer。UI 節點只有批准後建立；初版不提供 graph merge 或 parallel branch 操作。
