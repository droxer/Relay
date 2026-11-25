# Relay 文件

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

## 使用 Relay

| 主題 | 指南 |
| --- | --- |
| 開始使用 | [帳號與首次使用](guides/accounts.md)、[安裝應用程式](guides/pwa.md) |
| 組織及執行工作 | [任務](guides/task-lifecycle.md)、[自動化](guides/automations.md)、[團隊與工作流程](guides/team-workflows.md) |
| 設定智慧體 | [智慧體模型](guides/agents.md)、[已發佈技能](guides/skills.md)、[專案負責人與 Relay MCP](guides/project-manager.md) |
| 連接外部服務 | [連線](guides/connections.md)、[匯入 GitHub Issue](guides/github-connection.md) |

## 部署與維運

| 主題 | 指南 |
| --- | --- |
| 託管部署 | [Cloudflare 與 Railway 部署架構](guides/deployment-cloudflare.md#deployment-architecture)、[部署指令碼](../deploy/README.md)、[Vercel 替代方案](guides/deployment.md) |
| 後端與資料庫 | [維運與升級](guides/backend-operations.md)、[資料庫遷移](../backend/migrations/README.md)、[背景工作](guides/background-jobs.md) |
| 電腦 | [常駐程式參考](../packages/relay-daemon/README.md)、[心跳租約與回報復原](guides/node-heartbeats.md) |
| 聊天服務 | [聊天整合](guides/chat-integrations.md) |

## 開發與貢獻

- [本機開發](local-development.md)涵蓋環境設定、疑難排解與測試。
- [API 參考](api.md)涵蓋瀏覽器路由與 HTTP 契約。
- [程式碼導覽](CODEX-NAVIGATION-GUIDE.md)列出實作與測試入口。
- [領域術語](../CONTEXT.md)與[智慧體指引](../AGENTS.md)說明共用詞彙及儲存庫規則。
- [設計系統](design-system.md)、[字型](guides/typography.md)、[產品標籤](guides/product-copy.md)與[品牌資源](../assets/brand/README.md)涵蓋介面設計。

詳細指南以英文為準。

## 產品方向與決策

- [產品方向](product.md)和[目標架構](system-architecture.md)說明未來規劃。
- [架構決策](adr/README.md)保留長期有效的理由及各項決策的狀態。
- [進行中的提案](proposals/README.md)列出仍有待辦事項的設計。

## 保持精簡

同一主題優先更新既有指南。僅在仍有工作未完成時保留提案，並明確標示狀態。
長期有效的理由寫入 ADR；當指南與可執行測試涵蓋交付行為後，刪除已完成的計畫、
過期審閱、測試紀錄與產生的量測資料，歷史紀錄由 Git 保留。
移動或刪除文件時，同步更新參照並刪除不再使用的圖片。
