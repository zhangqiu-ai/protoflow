# ProtoFlow v0.1 架構

## 邊界與所有權

共享引擎包含狀態流程、分類、驗證和協定。目標專案包含產品內容、Skill、配置、AGENTS 約定及 `.protoflow/` 本機證據。引擎升級不覆寫目標配置、原型或應用。此版本沒有服務端、帳號系統、無限畫布或自動發布。引擎不預設目標專案的原型結構或元件；mapping 由專案配置，`mappings suggest` 只產生草稿。

| 模組 | 所有權／責任 |
|---|---|
| `bin/protoflow.js` | 參數、JSON輸出、退出碼、專案鎖 |
| `src/config.js` | schema 與路徑／配置檢查 |
| `src/install.js` | 非破壞 init、Skill installation、AGENTS managed block |
| `src/integrations.js` | Spec Kit／BMad 偵測、配置 argv 安裝、安裝提醒 |
| `src/source.js` | Git fetch、first-parent cursor、固定 SHA／完整資源 checkpoint、重寫檢查 |
| `src/runner.js` | 持久進度、隔離 worktree、前景 Codex FIFO／驗證修復與 doctor |
| `src/versions.js` | 每個原型版本的凍結副本與完整性核對 |
| `src/queue.js` | 原型版本佇列；應用端只能處理最早未驗收的版本 |
| `src/mappings.js` | 從目標專案原型頁面與引用資源起草 mapping（唯讀） |
| `src/sessions.js` | bounded snapshots、會話、diff、分類、debounced watch |
| `src/workflow.js` | Context、adapter、verification、repair、Review、Baseline |
| `src/visual.js` | Chromium scenes、geometry/style/region/full-view comparison |
| `src/util.js` | 原子 JSON、內容 hash、專案路徑、Git evidence、argv subprocess |
| `skills/protoflow/` | 給 Codex 的流程知識，不包含引擎副本 |

## 修改與路由

`session start` 立即保存原型內容。`watch` 在第一次變更前保留快照，之後每次變更延長 idle deadline；穩定後產生一個 checkpoint，避免每次 save 形成正式 UI 版本。原型快照包括檔案 hash、UTF-8 文字與 binary 標記；預設限制每檔 2 MiB、總計 20 MiB、1000 檔。超出限制會停止，不悄悄漏掉檔案。

checkpoint 保存 exact before/after hashes、文字 diff、增刪改、映射與 prototype 限定 Git diff/status；不碰 Git index。空 Git repository 的 HEAD 明確為 null。新的 checkpoint 使用上個 checkpoint 的原型內容，而不是依賴現在的 Git HEAD。

| 等級 | 初版偵測 | 路由 |
|---|---|---|
| L0 | CSS／僅樣式改動 | 映射 → Codex → Verify |
| L1 | DOM／局部 UI 互動 | 映射 → Codex → Verify |
| L2 | API、資料、未知 JavaScript／binary | Spec evidence → Codex → Verify |
| L3 | 權限、安全、架構、migration | Spec + 人工批准 ADR → Codex → Verify |

這是保守啟發式分類，不是完整語義分析。配置 path glob 規則和 `--level` 可提高風險；初版禁止降低推斷級別。變更沒有 mapping 時不能建立执行 context。人工應核對分類與需求，尤其是純樣式也影響產品語義的情況。

原型先按頁面拆分，應用沿用自己的元件架構，兩邊目錄不要求鏡像。單一 prototype 檔案可列入多筆 mapping；共用 tokens、styles、scripts 與 assets 由配置明確列出其消費者。檔案命中多筆 mapping 時全部列入影響範圍，不以 priority 或 selector 推測哪些元件可以省略。

此邊界採檔案粒度的保守展開：selector 負責視覺定位，沒有 DOM diff、CSS 使用分析或 import 依賴圖。移動／刪除檔案時，需同步原型資源引用、映射與驗證場景；checkpoint hash／Git evidence 不等於 Git 版本鎖定或自動提交。拆分方法與範例見 [原型拆分指南](prototype-structure.md)。

## 語意錨點（schemaVersion 2）

`schemaVersion: 2` 以平台中立的錨點取代 mapping（[提案 0001](proposals/0001-anchor-contracts.md)）。`src/anchors.js` 從快照確定性解析靜態合約（畫面、錨點、自身文字、sidecar 狀態、資源引用），`classifyChanges` 以前後合約差異產生 manifest `scope` 並提高等級；合約有錯誤時不發佈版本，Git 來源把無效提交折入下一個有效版本。`src/targets.js` 依 scope 與回歸政策產生「畫面 × 狀態」場景，在受監督的 Chromium（`src/browser.js`）內以 `src/drivers/web.js` 擷取凍結原型，應用端由 web 驅動器或 `src/drivers/external.js` 的 argv／JSON 協定擷取，`src/tiers.js` 比較四層。驗證 PASS 後更新錨點索引作為下一次執行的提示。`schemaVersion: 1` 的 mapping 路徑保持不變。

## 版本佇列

原型與正式應用是兩條版本流。設計端自由 checkpoint，每個 manifest 是一個原型版本；checkpoint 先把 `keepBytes` 快照寫入 `.protoflow/versions/<id>/files/`，最後寫 `index.json`，再發布 manifest，所以應用端看到的每個 manifest 都有完整凍結內容。`loadVersion` 以 index 重算 snapshot hash 並逐檔核對；沒有 index 的舊 manifest 只在現行原型仍等於 `afterHash` 時補凍結。

`versionQueue` 依 createdAt、id 排序 manifest，`current` 是第一個沒有綁定 PASS verification（`manifestId`、`manifestHash`、`prototypeHash` 皆相符）的版本。`createContext`、`prepareIntegration`、`executeContext`、`verify`（及 repair）在函式層呼叫 `assertCurrentVersion`；`createReview` 另允許已驗收版本。CLI 把 `VERSION_ORDER` 對應退出碼 3。每個 manifest 的 diff 只相對於前一個版本，順序推進保證應用不會跳過或合併原型變更。

應用 fingerprint 排除 `prototypeDir`，原型持續修改不會讓 context、verification、review 過期。執行器修改凍結版本會 FAIL；現行原型在執行期間變更只記錄 `livePrototypeChanged`，因為可能是設計者並行修改。視覺驗證以凍結副本作為原型來源：檔案 scene 改寫路徑，http scene 以 Playwright route 攔截 `visual.prototypeBaseUrl`（或推斷的 `/<prototypeDir>/`）下的請求；無法對應且現行原型已前進時該 scene FAIL，不退回比對錯誤版本。設計命令與應用命令分別持有 `design.lock` 與 `active.lock`。`policy.sequentialVersions: false` 明確停用順序檢查。

## 驗證與可信度

依序執行 build、functional，再執行 visual。build 可能產生應用資產，因此在 build 後記錄 acceptance 起點，並在 functional/visual 後重算 project fingerprint。驗證期間產品內容變動、checkpoint 原型變更、任何子檢查 FAIL 都導致 FAIL；未配置／缺少 Chromium／native 表面導致 NOT_RUN。

fingerprint 涵蓋專案檔案，排除 `.git`、`node_modules`、`.protoflow`、Playwright report/result。symlink 必須在專案內，並跟蹤來源內容；追蹤來源不能 symlink 到被排除的依賴或 state。專案 testing artifacts 建議放 `.protoflow/` 或預設 Playwright 目錄，避免 acceptance 自己改動被驗證內容。

視覺比較在獨立的 prototype/app browser contexts 執行相同 fixture 和步驟。等待字型／圖片就緒，停止 transition/animation，捕捉 viewport。幾何容差預設 1 CSS px；重要 computed styles 精確比較；pixelmatch 允許小量抗鋸齒容差。每個元件區域單獨比較，無平均權重掩蓋失敗。初版只驗證穩定場景，動畫時間軸需目標專案另寫 Playwright 測試。

每份 verification 綁定 manifestHash、prototypeHash、project hash、Git HEAD、命令 exit code/logs、各 scene 結果和每份圖片／HTML artifact 的 SHA256。Review 決定綁定 verificationHash 與 projectHash。批准與 Baseline 再檢查原型、實作、規格、圖片和所有證據沒有變動。

人工身分為本機明確輸入；此引擎不是加密簽章或身分驗證系統。Skill 禁止 agent 代替人類批准。`policy.autoApprove: true` 是唯一例外：Runner 交付時以 `ai:protoflow-runner` 記錄 `reviewerKind: automated` 的批准，檢查與人工批准相同的證據新鮮度，Baseline 也保留 `reviewerKind`；它不會被記錄成真人，也不適用 L3 ADR。`policy.requireHumanReview` 記錄 manifest 需 review 的意圖；初版正式 Baseline 一律要求人類批准，較嚴的最終 gate 不能由 false 略過。

## 自動修復

repair 先驗證。FAIL 且有 `--execute` 才建立新 context，將上一份驗證及 diff 傳到 Codex adapter，完成後重新驗證。每次最多一個執行者；預設最多 3 次，配置上限 10。缺少 adapter、規格／ADR、NOT_RUN、adapter 失敗或次數耗盡，停止並建立 pending Review 與 `NEEDS_REVIEW` 記錄。成功也只回傳 `READY_FOR_REVIEW`；批准由真實人類決定。

## 擴充與限制

新 integration 以 stdin Context/request 與 stdout response 協定接入，不將 Spec Kit 或 BMad 的內部檔案格式耦合進引擎。原生／裝置驗證可以透過目標 functional 命令執行，但本機 browser verifier 不會把它當 native 視覺 PASS。新增 native visual adapter、artifact 遠端儲存和畫布，可在此協定後逐步擴充。

CLI 透過 `.protoflow/active.lock`（應用端）與 `.protoflow/design.lock`（設計端）序列化專案操作，API 呼叫端需自行使用 `withLock`。原子檔案寫入能保護單一 JSON，不等於跨檔交易；異常退出後保留已寫入證據，人工檢查後恢復。引擎不隔離被配置的 subprocess；只執行專案明確信任的 adapter/test 命令，不對未知配置自動加權限。

## Git 來源與 Runner

Git 提交驅動流程、設定、離線／阻塞恢復與證據位置見 [本機 Runner](git-runner.md)。Git manifest 按 source.ordinal 排序；來源掃描和執行進度使用同一 active 鎖避免並行保存狀態遺失。Runner 另持 runner 鎖防止雙執行者。鎖 owner PID 確認已死才恢復，未知 owner 或仍活躍者拒絕。
