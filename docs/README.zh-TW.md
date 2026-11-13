# Relay 文件

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

## 從這裡開始

- [本機開發](local-development.md)：環境設定、服務、疑難排解與測試。
- [API 參考](api.md)：瀏覽器路由、HTTP 契約與功能行為。
- [程式碼導覽](CODEX-NAVIGATION-GUIDE.md)：實作歸屬與驗證方式。
- [產品方向](product.md)和[目標架構](system-architecture.md)：策略與規劃，不代表所有功能均已上線。
- [設計系統](design-system.md)：設計變數（tokens）與元件契約。
- [領域術語](../CONTEXT.md)與[智慧體指引](../AGENTS.md)。

## 使用與維運指南

| 主題 | 指南 |
| --- | --- |
| 託管部署 | [部署指令碼](../deploy/README.md)、[Cloudflare + Railway](guides/deployment-cloudflare.md)、[Vercel 替代方案](guides/deployment.md) |
| 資料庫升級 | [資料庫遷移](../backend/migrations/README.md)、[後端維運與升級注意事項](guides/backend-operations.md) |
| 背景處理 | [背景工作](guides/background-jobs.md) |
| 帳號與首次使用 | [邀請、密碼重設與導引](guides/accounts.md) |
| 智慧體與執行 | [智慧體模型](guides/agents.md)、[常駐程式參考](../packages/relay-daemon/README.md)、[心跳租約](guides/node-heartbeats.md) |
| 任務與自動化 | [任務生命週期](guides/task-lifecycle.md)、[自動化](guides/automations.md)、[專案經理與 MCP](guides/project-manager.md) |
| 外部服務 | [連線](guides/connections.md)、[公開 GitHub Issue 匯入](guides/github-connection.md)、[聊天整合後端](guides/chat-integrations.md) |
| 技能 | [已發佈技能](guides/skills.md) |
| 介面 | [字型](guides/typography.md)、[產品文案](guides/product-copy.md)、[安裝應用程式](guides/pwa.md)、[品牌資源](../assets/brand/README.md) |

詳細指南以英文為準。

## 決策與提案

- [架構決策](adr/README.md)保留長期有效的理由及每項決策的狀態。
- [設計提案](proposals/README.md)集中未完成的設計；閱讀狀態說明後，再判斷哪些行為已經實作。
- [產品截圖](images/)供英文與中文專案說明使用。

## 保持精簡

同一主題優先更新既有指南。僅在仍有工作未完成時保留提案，並明確標示狀態。
長期有效的理由寫入 ADR；當指南與可執行測試涵蓋交付行為後，刪除已完成的計畫、
過期審閱、測試紀錄與產生的量測資料，歷史紀錄由 Git 保留。
移動或刪除文件時，同步更新參照並刪除不再使用的圖片。
