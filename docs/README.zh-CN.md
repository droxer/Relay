# Relay 文档

[English](README.md) | [简体中文](README.zh-CN.md)

本索引标明每个文档主题的权威归属。概览文档只负责总结和链接，不应复制权威文档中的操作细节。除本索引和项目概览外，链接指向的详细文档目前以英文为准。

## 从这里开始

- [`../README.zh-CN.md`](../README.zh-CN.md) — 中文产品概览和最短的开发环境启动路径。
- [`local-development.md`](local-development.md) — 环境、配置、服务、数据布局和测试流程的权威指南。
- [`deployment.md`](deployment.md) — 权威托管部署流程（Web UI 部署在 Vercel，后端与
  Postgres 部署在 Railway）及其所需的 origin、cookie 和代理配置。
- [`../backend/migrations/README.md`](../backend/migrations/README.md) — 数据库迁移和旧对话导入的权威流程。
- [`api.md`](api.md) — 当前浏览器路由和 HTTP API 契约。
- [`../AGENTS.md`](../AGENTS.md) — Codex 使用的仓库结构、工程不变量和验证指南。
- [`../CLAUDE.md`](../CLAUDE.md) — Claude Code 使用的命令、架构细节、不变量和测试指南。
- [`../CONTEXT.md`](../CONTEXT.md) — 简短的权威产品术语表。
- [`CODEX-NAVIGATION-GUIDE.md`](CODEX-NAVIGATION-GUIDE.md) — 行为的权威来源、
  必须联动变更的相邻表面，以及评审 diff 包中应包含的证据（英文）。

## 产品与架构

- [`product.md`](product.md) 负责产品方向、用户、场景和路线图。
- [`agent-facing-product-design.md`](agent-facing-product-design.md) 负责面向员工的智能体模型和词汇边界。
- [`system-architecture.md`](system-architecture.md) 负责目标架构和战略技术选择。
- [`implementation-plan.md`](implementation-plan.md) 将目标架构转换为服务边界、数据模型、API、运行流程和实施阶段。
- [`agent-first-runtime-design.md`](agent-first-runtime-design.md) 负责逻辑智能体运行时设计。
- [`managed-node-provisioning.md`](managed-node-provisioning.md) 负责托管计算机的期望状态、注册、协调和供应商生命周期。
- [`node-heartbeats.md`](node-heartbeats.md) 负责执行平面的存活租约。
- [`chat-integrations.md`](chat-integrations.md) 负责聊天渠道的供应商配置、身份映射、命令、安全和运维（该功能默认关闭，需设置 `RELAY_CHANNELS_ENABLED`）；[`relay-chat` 软件包说明](../packages/relay-chat/README.md)仅描述软件包边界。
- [`relay-daemon` 说明](../packages/relay-daemon/README.md)负责守护进程环境和交付契约。

## 决策与设计

- [`adr/README.md`](adr/README.md) 汇总已接受的架构决策。ADR 保留决策原因；上面的动态指南描述当前契约。
- [`design-system.md`](design-system.md) 是唯一持续维护的视觉系统与设计令牌参考。
- [`../assets/brand/README.md`](../assets/brand/README.md) 描述品牌资源文件及其用法，不重复设计令牌。

## 归属规则

1. 将当前命令和配置写入最接近其职责的操作指南，概览文档只链接到该指南。
2. 将长期有效的决策理由写入 ADR，不在其中重复完整的当前契约。
3. 仅在仍有工作未完成时保留实施或迁移计划，并标注日期和状态；当持续维护的契约与测试已经描述交付行为后，删除该计划。
4. 不要在动态文档目录中保留已完成的实施日志、过期审查、设计探索或测试证据；Git 历史和可执行测试套件负责保存这些记录。
5. 替换设计时，更新持续维护的权威文档；在 ADR 中保留长期有效的决策理由后，删除已取代的文档。
6. 面向不同智能体的指令文件可以重复关键命令和不变量，使每个智能体无需读取另一个智能体的启动文件即可获得完整上下文。
