# Relay 文档

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

## 使用 Relay

| 主题 | 指南 |
| --- | --- |
| 开始使用 | [账号与首次使用](guides/accounts.md)、[安装应用](guides/pwa.md) |
| 组织和执行工作 | [任务](guides/task-lifecycle.md)、[自动化](guides/automations.md)、[团队与工作流](guides/team-workflows.md) |
| 配置智能体 | [智能体模型](guides/agents.md)、[已发布技能](guides/skills.md)、[项目负责人和 Relay MCP](guides/project-manager.md) |
| 连接外部服务 | [连接](guides/connections.md)、[导入 GitHub Issue](guides/github-connection.md) |

## 部署与运维

| 主题 | 指南 |
| --- | --- |
| 托管部署 | [Cloudflare 与 Railway 部署架构](guides/deployment-cloudflare.md#deployment-architecture)、[部署脚本](../deploy/README.md)、[Vercel 替代方案](guides/deployment.md) |
| 后端和数据库 | [运维与升级](guides/backend-operations.md)、[数据库迁移](../backend/migrations/README.md)、[后台任务](guides/background-jobs.md) |
| 计算机 | [守护进程参考](../packages/relay-daemon/README.md)、[心跳租约与报告恢复](guides/node-heartbeats.md) |
| 聊天服务 | [聊天集成](guides/chat-integrations.md) |

## 开发与贡献

- [本地开发](local-development.md)涵盖环境搭建、故障排查和测试。
- [API 参考](api.md)涵盖浏览器路由和 HTTP 契约。
- [代码导航](CODEX-NAVIGATION-GUIDE.md)列出实现和测试入口。
- [领域术语](../CONTEXT.md)与[智能体指引](../AGENTS.md)说明共享用语和仓库规则。
- [设计系统](design-system.md)、[字体](guides/typography.md)、[产品标签](guides/product-copy.md)与[品牌资源](../assets/brand/README.md)涵盖界面设计。

详细指南以英文为准。

## 产品方向与决策

- [产品方向](product.md)和[目标架构](system-architecture.md)说明未来规划。
- [架构决策](adr/README.md)保留长期有效的理由及各项决策的状态。
- [进行中的提案](proposals/README.md)列出仍有待办工作的设计。

## 保持精简

同一主题优先更新已有指南。仅在仍有工作未完成时保留提案，并明确标注状态。
长期有效的理由写入 ADR；当指南和可执行测试覆盖交付行为后，删除已完成的计划、
过期评审、测试日志和生成的测量数据，历史记录由 Git 保留。
移动或删除文档时，同步更新引用并删除不再使用的图片。
