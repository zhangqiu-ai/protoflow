# ProtoFlow 工程約定

ProtoFlow 是共享 Node.js 引擎；目標專案僅接入 Skill 與 `protoflow.config.json`，不得複製引擎。
文件採繁體中文，程式碼與識別字保持英文。保留既有檔案與 Git index，不自動 commit/push。
模組修改需有對應可重複測試；瀏覽器可覆蓋的驗收必須透過 Node.js Playwright runner。
整合外部代理只透過明確配置的 argv 與 stdin JSON；未執行的驗證記錄為 NOT_RUN。
初版不包含無限畫布、雲端部署、憑證管理。人工批准必須綁定當前內容與驗證證據。
