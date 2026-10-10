# 獨立 AI review gate

交付在本地 commit 後，任何 automated approval、push 或 merge 前取得獨立 AI review。驗收 PASS 不代替 review PASS。配置 `adapters.independentReview.command.argv` 為 `["node", "/absolute/shared-engine/scripts/codex-review-adapter.js"]`；可追加 `"--model", "MODEL"`，不可追加 resume、fork、sandbox bypass 或其他參數。未配置會 BLOCKED，不套用虛構的預設 reviewer。

橋接使用既有 Codex CLI 登入，不新增 token／scope。從可信 PATH 解析 Codex 實體 executable，將完整 path／file SHA256 綁定於 request 和 raw run，直接 spawn 該絕對路徑，結束和恢復時再次核對。固定 `codex exec --json --sandbox read-only --ephemeral --ignore-user-config -c approval_policy="never" --output-schema FILE -`，不載入使用者的執行設定、不延續 executor session。Review 只讀完整 source、測試和 acceptance evidence，不執行應用／Runner／build／tests 或 GitHub 操作。這是 AI evidence，不是真人 ADR、GitHub approval 或 branch protection 的替代品。

嚴格 verdict 包含 protocol、requestId、bindingHash、status、findings 和 summary；未知欄位拒絕。模型 final JSON 必須在原始 Codex JSONL 中，含單一 `thread.started`、`turn.started`、`turn.completed` 且沒有 error／turn.failed。只有 PASS 且 findings 為空才有效；exit zero、單字 PASS、Runner 自填 session 或 boolean 都不能授權。

## 重用接口

```js
import { requestIndependentReview, assertIndependentReview } from '@zhangqiu-ai/protoflow';

const review = await requestIndependentReview(projectRoot, config, {
  worktree: applicationCheckout,
  commit: applicationHead,             // 必須等於 applicationCheckout 的 HEAD
  expectedBaseSha: currentMainSha,      // 可選；交付 commit 使用的精確 current base
  manifestIds: [acceptedManifestId],   // 主 root source state（多目標時為該 target 進度）的 PASS entry／新 VER
  target: targetId,                    // 多目標（schemaVersion 2 且 targets > 1）時必填；單一 target 省略
  executorEvidence: [{
    path: '.protoflow/provenance/EXEC-original.json',
    hash: completeFileBytesSha256      // SHA256(readFile(...))，不是 JSON stringify hash
  }],
  ambientAuthorIds: [actualAuthorThreadId],
  signal
});
if (review.status !== 'PASS') throw new Error(review.reason);

await assertIndependentReview(projectRoot, config, review.id, {
  worktree: applicationCheckout,
  commit: applicationHead,
  manifestIds: [acceptedManifestId],
  published: false
});
// 經呼叫方另行授權的普通 push 後：
await assertIndependentReview(projectRoot, config, review.id, { published: true });
```

`requestIndependentReview` 回傳有 id 的 PASS 或 BLOCKED 紀錄；本身不 commit、approve、push、PR 或 merge。若 base 物件缺失，僅 fetch 精確已觀察 base SHA 的 objects，不更新 ref、FETCH_HEAD、index 或工作內容。`assertIndependentReview` 成功回傳紀錄、binding、verdict 和 observedRemoteHead；失敗拋出 `code: INDEPENDENT_REVIEW_BLOCKED`。

`executorEvidence` 是私有 project-relative 路徑加完整檔案 bytes SHA256，可選 manifestId；必須位於 `.protoflow/`。文件必須是原始成功 EXEC record：id、status、request.kind（implement／repair）、完整 request.manifest／manifestHash、result.status／exitCode／stdout。session 從 stdout 的完整 JSONL 取得，完整文件與 raw trace 各自保存 hash。每個 accepted manifest 必須有 provenance；移植時保留原 bytes 和 source／manifest，不重寫原 execution。未提供此陣列時，gate 從該 source entry 的成功 attempts.executionId 讀取 worktree contexts。裸 sessionId 不受支援。

`ambientAuthorIds` 只補充已知作者 thread 排除名單；目前環境 `CODEX_THREAD_ID` 也不能成為 reviewer。它不代替 executor trace。CLI／登入及共享引擎屬於可信執行環境；本地 trace hash 提供完整性和可稽核來源，不是假稱 provider 的密碼學簽章。

真正的授權錨點是共享引擎程序內、模組私有的 attestation；只有已實際完成的 adapter／provider PASS 才建立，綁定完整 AIR record、request、run、process 和 options。磁碟上的 JSON／JSONL 即使全部重算 hash 也不能建立或改寫這個錨點。程序重啟後錨點不存在，已保存的 PASS 只能供稽核，正常 sync 保守 BLOCKED；不自動重跑任何 review。需明確選定 deliveryId／reviewId 執行下述新 provider revalidation。應用與 executor 不得修改可信共享引擎或其程序記憶體；本地可寫的證據目錄不屬於可信授權儲存。

binding 包含 HEAD/tree、主 root HEAD、完整 workspace content hash（含 live prototype）、application hash（排除 prototype）、source entry、manifest／新 VER 全 hash、frozen version 和 artifact 完整性、executor 文件與 trace/session、config 和 remote URL/base/head。只忽略 `.git`、`.protoflow`、node_modules 和測試輸出等既有 runtime 目錄。工作中的 application bytes／modes 必須吻合被 commit 的 tree。主 root 是 manifest／VER 權威；snapshot 只容許 top-level runnerWorktree 匯出 metadata 差異。

交付 remote 必須只有一個有效 push URL，且為 `https://github.com/OWNER/REPO[.git]` 或 `git@github.com:OWNER/REPO[.git]`。base／head 查詢、必要 fetch 與普通 push 使用同一個已綁定的 URL 字串；不同 fetch URL 不參與交付。多個 push URL、Git URL rewrite 與 `GIT_CONFIG*` 環境覆寫一律 BLOCKED；所有 review／交付 Git 操作移除外部 `GIT_*`、停用 hooks／fsmonitor，並固定 `--no-replace-objects`。拒絕 legacy `info/grafts`，另以引擎設定的 `GIT_GRAFT_FILE=/dev/null` 防止 graft 在檢查後影響命令；commit／tree／blob 檢查和 push 使用相同原始 objects。透過指定 `repos/OWNER/REPO` 與 `--hostname github.com` 的 `gh api` 解析 canonical repository ID／full_name／URL，拒絕轉向其他 repository；此身份也納入 binding。每個 `gh pr` 操作使用 `--repo github.com/OWNER/REPO`，移除環境 `GH_REPO` 並固定 `GH_HOST=github.com`。來源掃描仍可使用明確 local Git fixture；交付測試只在測試專用 Git executable 將上述 GitHub URL 映射至 local bare repository，production 沒有 fixture bypass。

發現、恢復或建立的 PR 都透過指定 REST pull-request endpoint 核對 head／base repository 的 canonical numeric ID／full_name／URL、精確 head／base SHA 與 branch，拒絕 fork 的同名 branch。建立、留言、ready、merge 各自執行前和寫入 `PR_OPEN_MANUAL` 前都重新 assert，避免慢速 discovery／create／view 期間的內容或 refs 漂移。

已 commit 的 application symlink 不受支援：gate 只接受與實際 bytes／mode 吻合的普通檔案。既有 runtime exclusions（例如 node_modules symlink）仍排除於交付與 binding。

當前 remote base 必須是 application HEAD 的祖先，不能將舊 HEAD 加上較新的 base SHA 宣稱完成整合。`expectedBaseSha` 若指定，必須等於實際觀察的 base，也會被保存供恢復核對。

`runner.delivery.paths` 可選明確 repo-relative 前綴，例如 `["app/clean-electron", "package.json"]`；省略時保留既有完整 staging 行為。指定時 Git add 只含 scope，既有 index 有 scope 外 staged 內容即停止並保留。拒絕 traversal、prototype、私有／憑證／runtime 路徑；完整應用驗收中的新內容也必須確實已 commit，不能因 whitelist 漏掉 root 內容仍稱 PASS。Commit trailers 保存 source SHA、manifest／verification／application hash 和 current base SHA。

`runner.delivery.draft: true` 建立 draft PR。`merge: "manual"`（或既有 `"none"`）保持 draft 給人工處理；後續版本可重用同一 PR。`merge: "auto"` 時，只有該版本獨立 gate PASS、refs 與內容重核對通過後才執行 `gh pr ready`，接著正常 merge，仍不做 GitHub 自我批准或 --admin。Automated review 保存被 review 的 commit／tree／base SHA；automated baseline 的 application.git 指向該 commit，verificationGit 另外保留驗收時 HEAD，人工 baseline 的既有語義保持。

`published: false` 要求 branch tip 等於 review 前 tip；`true` 要求精確等於被 review 的 commit；`'either'` 只容許這兩個已知 SHA，供未知 push 結果恢复核對。這三者均不允許其他 head 或 base 漂移。每個外部操作前重新 assert；branch protection 仍在伺服器端控制合併，不以 --admin 繞過。已完成 MERGED 紀錄不重做。

證據保留在 `.protoflow/delivery/independent-reviews/`，包括 request、完整 provider process result、raw trace/run、verdict、session 和 hash；不得把私有整份紀錄貼至 PR。局部單元測試明示 FAKE provider／acceptance，不能當作真實 AI review 或產品驗收 PASS。

## 多目標交付（schemaVersion 2）

v1 與單一 target 的 v2 專案沿用上述路徑與分支。`targets` 有多筆時，gate 以 target 為單位運作，每個 target 的交付各自需要獨立 review PASS 才能 automated approval、push、PR 與 merge：

- request 的 `target` 必填且必須是已配置的 target；binding 與 AIR 紀錄保存 target，`assertIndependentReview` 傳入其他 target 時 BLOCKED，一個 target 的 PASS 不能授權兄弟 target。
- source／VER 與 executor provenance 取自該 target 的進度 `.protoflow/targets/<id>/progress.json`，worktree 為該 target 的 `worktree-<hash>-<id>`。
- application hash 與該 target 驗收相同：排除 prototype 與其他 target 的 root；完整 workspace content hash 仍涵蓋全部內容。committed tree 中兄弟 target root 的檔案不視為本 target 的 application。
- remote binding 與 push、PR、merge 使用該 target 的交付分支 `<runner.delivery.branch>/<id>`，交付紀錄在 `.protoflow/delivery/<id>.json`；review 紀錄仍集中於 `.protoflow/delivery/independent-reviews/`，以唯一 AIR ID 區分。
- 交付 commit 只能包含該 target root 與共享的頂層檔案；staged 內容落在兄弟 target root 時，在 review 前 BLOCKED。
- 兄弟 target 合併後 base 會前進，使本 target HEAD 不再以 current base 為祖先。此時交付先在 commit 後檢查：base 自分叉點以來變更的檔案若只在兄弟 target root、prototype 或 runtime 目錄內，才以 `--no-ff` 將精確 base SHA merge 進本 target worktree，且合併前後本 target 的 application hash 必須相同；否則 BLOCKED 並要求在新 base 上重新驗收。若 base 改了共享頂層檔案或本 target root，也一律 BLOCKED。合併結果記錄於 delivery `integration`，PR 留言標示，review 針對包含該 base 的 HEAD 與 `base..HEAD` diff 執行。單一 target 不做此整合，base 前進仍 BLOCKED。
- merge 後的 Runner 對齊只作用於該 target 自身的 `.protoflow/runner/<id>/state.json` 與 worktree。

正常 sync 不自動重跑 BLOCKED review。確認失敗原因後，可用明確接口啟動新 attempt：

```js
await syncDeliveries(projectRoot, config, {
  worktree: applicationCheckout,
  target: targetId,                    // 僅多目標
  retryIndependentReview: { deliveryId: blockedDelivery.id, reviewId: blockedDelivery.independentReviewId }
});
```

多目標時另傳 `target`；未指定 target 的重試直接 BLOCKED。

失敗 review 重試只接受指定的當前 BLOCKED attempt，且 delivery 尚未 approval／push／PR。程序重啟後，這個相同的明確選取接口也接受尚未完成 delivery 的磁碟 PASS：必須沒有 live attestation，才建立新的 AIR 並實際執行 provider；既有 live attestation 有漂移時不能以此重試。新 request 重做全部 acceptance／HEAD／base 核對；已發布者仍須保持相同 commit／current base／PR 身份。舊 AIR record、process、raw trace 和 verdict 不覆寫，state 保存 independentReviewAttempts 及 supersedes。若曾 automated approval，新 provider PASS 後建立引用新 AIR 的 approval／baseline，原引用另存 approvalHistory，不把舊批准當新授權。真正 FAIL／BLOCKED 不會自動重試。直接呼叫 requestIndependentReview 每次也產生不同 AIR ID。
