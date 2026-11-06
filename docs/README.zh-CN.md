# Relay 文档

[English](README.md) | [简体中文](README.zh-CN.md)

## 从这里开始

- [本地开发](local-development.md)：环境搭建、服务、故障排查和测试。
- [API 参考](api.md)：浏览器路由、HTTP 契约和功能行为。
- [代码导航](CODEX-NAVIGATION-GUIDE.md)：实现归属与验证方式。
- [产品方向](product.md)和[目标架构](system-architecture.md)：战略与规划，不代表所有功能均已上线。
- [设计系统](design-system.md)：界面令牌和组件契约。
- [领域术语](../CONTEXT.md)与[智能体指引](../AGENTS.md)。

## 使用与运维指南

| 主题 | 指南 |
| --- | --- |
| 托管部署 | [部署脚本](../deploy/README.md)、[Cloudflare + Railway](guides/deployment-cloudflare.md)、[Vercel 替代方案](guides/deployment.md) |
| 数据库升级 | [数据库迁移](../backend/migrations/README.md)、[后端运维与升级注意事项](guides/backend-operations.md) |
| 后台处理 | [后台任务](guides/background-jobs.md) |
| 账号与首次使用 | [邀请、密码重置与引导](guides/accounts.md) |
| 智能体与执行 | [智能体模型](guides/agents.md)、[守护进程参考](../packages/relay-daemon/README.md)、[心跳租约](guides/node-heartbeats.md) |
| 任务与自动化 | [任务生命周期](guides/task-lifecycle.md)、[自动化](guides/automations.md)、[项目经理与 MCP](guides/project-manager.md) |
| 外部服务 | [连接](guides/connections.md)、[公开 GitHub Issue 导入](guides/github-connection.md)、[聊天集成后端](guides/chat-integrations.md) |
| 技能 | [已发布技能](guides/skills.md) |
| 界面 | [字体](guides/typography.md)、[产品文案](guides/product-copy.md)、[安装应用](guides/pwa.md)、[品牌资源](../assets/brand/README.md) |
| 性能调查 | [本地后端基准测试](guides/backend-benchmark.md) |

详细指南以英文为准。

## 决策与提案

- [架构决策](adr/README.md)保留长期有效的理由及各项决策的状态。
- [设计提案](proposals/README.md)集中未完成的设计；阅读状态说明后再判断哪些行为已经实现。
- [产品截图](images/)供中英文项目概览使用。

## 保持精简

同一主题优先更新已有指南。仅在仍有工作未完成时保留提案，并明确标注状态。
长期有效的理由写入 ADR；当指南和可执行测试覆盖交付行为后，删除已完成的计划、
过期评审、测试日志和生成的测量数据，历史记录由 Git 保留。
移动或删除文档时，同步更新引用并删除不再使用的图片。
