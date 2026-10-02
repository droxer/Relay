# Relay

<p align="center">
  <img src="assets/brand/relay-logo.svg" alt="Relay 标志" width="380">
</p>

<p align="center"><strong>让每一位员工，能力倍增。</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Relay 帮助员工通过对话、议题、例行任务和项目与 AI 智能体协作。你可以为智能体命名、配置角色和技能，选择运行位置，并与团队共享需求、运行过程和结果。

Relay 采用本地优先架构：后端协调工作，守护进程在员工计算机或托管计算机上执行。每个守护进程在主机工作区或 [BoxLite](https://github.com/boxlite-ai/boxlite) 沙箱中运行 [Claude Code](https://github.com/anthropics/claude-code)、Codex、Pi 或 Kimi。

<p align="center">
  <img src="docs/images/relay-threads-zh-CN.png" alt="Relay 对话：一个智能体修复缺陷后交接给另一个智能体，后者的评审正在实时输出" width="960">
</p>

## 功能特性

- **对话** — 在你选择的计算机上与智能体、团队或项目协作。实时查看推理、命令和工具调用，按需停止、重试或交接工作。
- **议题** — 将工作分配给智能体或团队，设置优先级和截止日期，从待办跟踪到完成。每个议题保留运行历史和产出文件。
- **例行任务** — 按每日、每周或每月安排周期性工作；Relay 会将每次运行派发给负责人。
- **项目** — 在同一台计算机上组织共享工作区和参与项目的智能体。
- **智能体与团队** — 为每个智能体配置运行时、角色、个性和技能。将智能体组成团队，协作方式可选单人、构建 → 评审、流水线或负责人主导。
- **技能** — 发布带版本的技能包，并通过共享技能库授予智能体。
- **计算机** — 注册员工计算机或托管计算机，查看其健康状态、运行时和正在运行的工作。
- **管理** — 在同一个管理控制台中管理员工、计算机、活动和令牌用量。

## 产品导览

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/relay-issues-zh-CN.png" alt="Relay 议题表，按项目分组">
      <br><strong>议题</strong><br>汇总所有项目中未完成的议题，并按待处理队列分类。
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/relay-projects-zh-CN.png" alt="Relay 项目看板">
      <br><strong>项目</strong><br>从待办到完成的项目看板，附流动指标。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/relay-routines-zh-CN.png" alt="Relay 例行任务列表">
      <br><strong>例行任务</strong><br>周期性工作及其执行频率、下次运行时间和负责人。
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/relay-agents-zh-CN.png" alt="Relay 智能体档案">
      <br><strong>智能体</strong><br>运行时、所在计算机、角色、个性和技能。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/relay-teams-zh-CN.png" alt="Relay 团队档案">
      <br><strong>团队</strong><br>成员、职责，以及工作如何在成员之间流转。
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/relay-skills-zh-CN.png" alt="Relay 技能库">
      <br><strong>技能</strong><br>带版本的技能包及其文件和修订历史。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/relay-computers-zh-CN.png" alt="Relay 计算机页面">
      <br><strong>计算机</strong><br>每台计算机正在运行的工作和已就绪的运行时。
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/relay-admin-zh-CN.png" alt="Relay 管理仪表板">
      <br><strong>管理控制台</strong><br>对话数量、集群健康和令牌用量。
    </td>
  </tr>
</table>

截图使用深色主题和演示数据，由 [`script/readme-snapshots`](script/readme-snapshots/capture.mjs) 生成。

## 快速开始

你需要 Node.js 22.19+、npm、Python 3.12+、[uv](https://docs.astral.sh/uv/) 和 PostgreSQL。使用默认的 BoxLite 沙箱还需要 Docker、硬件虚拟化支持，以及所需智能体的凭据。

以下命令均在仓库根目录执行。

### 1. 安装与配置

```bash
npm install
npm run build
```

复制环境变量示例文件并填入智能体凭据（详见[本地开发指南](docs/local-development.md)）：

```bash
cp backend/.env.example backend/.env
cp web/.env.example web/.env.local
cp packages/.env.example packages/.env
```

### 2. 初始化数据库和管理员账户

Relay 将会话、任务、事件与产物存储在 PostgreSQL 中。先创建 `backend/.env` 中 `RELAY_DATABASE_URL` 指定的角色和数据库。示例使用 `localhost:5432` 上的角色 `relay` 和数据库 `relay`。然后运行数据库迁移：

```bash
make backend-migrate
```

创建第一个管理员账户（没有默认密码）：

```bash
script/init_users.sh --password 'choose-a-strong-password'
```

### 3. 启动服务

在不同终端中分别启动服务：

```bash
make backend                     # 控制平面，监听 127.0.0.1:8790
make daemon SANDBOX_ID=node_dev  # 连接后端的执行节点
make web                         # Web 界面，监听 127.0.0.1:5000
```

打开 <http://127.0.0.1:5000>，以 `admin` 身份登录。

测试、数据库迁移、协调器、pre-commit 钩子和停止命令请参阅[本地开发指南](docs/local-development.md)。

## 项目结构

```
backend/     Python / FastAPI 控制平面：API 路由、事件溯源存储、调度器、数据库迁移
packages/    TypeScript 工作区
  relay-core/        共享协议、智能体注册表、CLI 命令、提示词
  relay-chat/        聊天网关及 Discord、Telegram、Lark 适配器
  relay-daemon/      执行平面：注册计算机并运行智能体 CLI
  relay-supervisor/  确保员工守护进程已部署并保持运行
web/         Next.js Web 界面，静态导出后由后端提供服务
docs/        架构、API、部署、设计系统文档及 ADR
script/      用户初始化、演示数据、README 截图生成脚本
devbox/      沙箱内智能体所运行的 BoxLite 客户机镜像
```

## 参与贡献

1. 按照[快速开始](#快速开始)在本地运行整套服务。
2. 阅读 [`AGENTS.md`](AGENTS.md) 了解仓库指南和不变式，并在 [`docs/adr/`](docs/adr/README.md) 中查阅过往的设计决策。
3. 提交 Pull Request 前运行 `npm test`（TypeScript 与 Python 测试）和 `make pre-commit-run`。
4. 行为发生变化时，同步更新 [`docs/`](docs/README.zh-CN.md) 下对应的页面。

详细的目录结构以及各类改动的入手位置，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)（英文）。

## 部署

[`docs/deployment.md`](docs/deployment.md) 介绍如何将 Web 界面部署到 Vercel、将后端和 Postgres 部署到 Railway。将守护进程部署在执行智能体的计算机上，通过出站 HTTP(S) 连接后端。

## 文档

从 [`docs/` 中文索引](docs/README.zh-CN.md)开始，查找环境搭建、API、架构、设计和决策的权威文档。

## 许可证

[AGPL-3.0-only](LICENSE)
