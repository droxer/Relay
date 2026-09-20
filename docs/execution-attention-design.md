# Execution needs attention：原因与恢复设计

状态：核心修复已实施，见 [实现与验证](testing/execution-attention-fix.tdd.md)。下文保留设计提案；统一通用 actions 模型、历史扫描与监控面板属于后续扩展，当前使用现有 execution 能力字段和任务 attention 投影。依据：2026-09-20 当前代码和执行阻塞复现。

## 目标

每条需要处理的执行提示都回答三个问题：发生了什么、Relay 已确认什么、现在能做什么。
未知原因必须如实显示为未知，并提供关联记录；不能仅靠替换文案制造一个确定的诊断。
已经失败的调度仍需人工重试，不引入自动重跑策略。

## 当前问题及代码依据

1. `backend/relay/persistence/task_lifecycle.py:62`：blocked 事件没有 reason，
   且任务没有既有 blockerReason 时，写入 `Execution needs attention.`。
   手工阻塞 API 已要求原因，缺口主要需要沿内部事件、历史数据查证，不能归因于所有手工操作。
2. `web/src/lib/executionRecovery.ts`：会话的未知 blockingReason 使用 unknown 提示。
   同时默认带上 reportGone；实际 reconcile API 则仅接受 recovery_required，
   因而前端可展示一个后端必然拒绝的操作。
3. 任务恢复提示依赖 dispatchOutcome.code；运行阶段失败通常只有自由文本。
   任务选择 `linkedSessionIds.at(-1)` 作为入口，不能证明该会话就是本次阻塞的来源。
4. 已有 ExecutionRecoveryPanel、TaskRecoveryPanel、保存重试及人工 reconcile 路径。
   扩展这些模块，保留现有入口，不另建一套状态机。

## 后端统一提供诊断与操作能力

新增只读诊断投影，复用 execution_status、调度原因和执行所有权数据。
执行阶段继续使用现有 phase；新增 code 表达问题原因，两者不互相替代。

建议响应形状：

```ts
type ExecutionAttention = {
  schemaVersion: 1;
  code: string; // 开放集合，旧客户端必须容忍新 code
  category: "assignment" | "availability" | "workspace" | "execution"
    | "delivery" | "persistence" | "unknown";
  severity: "info" | "warning" | "error";
  summary: string; // 经脱敏、限长的实际原因；本地化主要按 code 映射
  source: "dispatch" | "daemon" | "finalization" | "operator" | "legacy";
  observedAt?: string;
  evidence: "recorded" | "derived" | "unknown";
  executionPhase?: string;
  executionState: "not_started" | "active" | "exit_unconfirmed" | "exited" | "unknown";
  taskId?: string;
  sessionId?: string;
  runRequestId?: string;
  commandId?: string;
  blockingSessionId?: string;
  actions: Array<{
    type: "open_thread" | "open_computer" | "edit_assignment"
      | "retry_save" | "unblock" | "retry_execution" | "report_gone";
    enabled: boolean;
    disabledReason?: string;
    requiresConfirmation?: boolean;
  }>;
};
```

返回当前用户有权查看的关联对象；不暴露 token、环境变量、完整日志、私有主机路径。
actions 是按请求用户计算的能力，不持久化进共享事件/缓存。执行操作时后端重新验证
phase、所有权、权限及记录版本，旧页面的 enabled 不能作为授权依据。

诊断优先级：先定位当前执行所有者；若其退出未确认或结果未保存，优先展示该执行阻塞。
没有当前所有者时，使用本次 blocked 事件关联的执行/调度原因；最后才读取历史自由文本。
旧 dispatchOutcome 不得覆盖新一轮执行、人工等待或 review。
不同执行的原因不能仅凭时间邻近合并；没有可靠关联时保留 unknown。

## 原因与操作矩阵

| 情况 | 用户看到什么 | 操作及前置条件 |
| --- | --- | --- |
| Agent/团队/项目不存在或禁用 | 指出需修正的具体分配 | 打开对应配置；修正后人工重试 |
| 节点离线或初始容量不足，尚未失败 | 等待电脑恢复/执行空位 | 打开电脑；保留现有排队策略 |
| workspace_busy | 等待某个会话释放工作区 | 打开实际阻塞会话；不提供重复启动 |
| workspace_status_delivery_failed | 工作区状态更新失败 | 仅在 daemon 提供证据时使用此 code；查看相关会话 |
| agent_preflight_failed / agent_exit_failed | 启动检查或执行失败，附实际摘要 | 确认退出、释放所有权且修复原因后人工重试 |
| terminal_delivery_failed | 执行结果尚未送达后台 | 需 daemon 的独立观测证据；后台无证据时显示退出未确认 |
| finalization_failed | 已收到结束结果，但保存失败 | 重试保存，复用现有 recovery 接口，不重新执行 |
| execution_unconfirmed / termination_unconfirmed | 无法确认进程是否已退出 | 检查电脑；达到 recovery_required 后才允许人工报告已停止 |
| manual_block | 用户记录的阻塞原因 | 无活动执行时解除阻塞 |
| unknown | 缺少可验证的阻塞原因 | 查看关联记录；操作取决于实际 phase，不按 unknown 自动授权 |

`workspace_status_delivery_failed`、`terminal_delivery_failed` 为拟新增诊断，
不能由后台依据“长时间没收到消息”推断。daemon 的诊断通过可用通信路径上报，
完全断连时只能保留最后观测和不确定状态。

人工报告已停止是操作人员的声明，不是远程 kill。沿用现有确认框和审计事件，
明确说明它只释放 Relay 的保留状态，无法停止主机上仍然运行的进程。

## 页面表现

在现有面板内展示具体标题、原因、最后确认时间和一个主要操作。详细记录默认折叠。
任务卡片显示一行具体摘要；详情抽屉和会话面板使用相同诊断投影。
正常排队、等待用户及 review 使用信息提示，真实故障才使用警告。

例一：

```text
执行结果保存失败
Agent 已结束，Relay 已收到结果；保存任务状态时失败。
最后确认：14:32:08
[重试保存]  [查看执行记录]
```

例二：

```text
尚未确认 Agent 已停止
电脑失去连接，Relay 暂时保留本次执行。最后确认：14:32:08。
[检查电脑]  [查看执行记录]
```

达到后端允许的 recovery_required 阶段后，例二才额外出现「报告 Agent 已停止」。
未知情况显示「暂时无法确定阻塞原因」，附记录入口，不继续重复笼统标题与笼统正文。
恢复请求被接受时显示“已请求恢复”，只有重新获取状态确认成功后才显示“已恢复”。

## 写入与历史兼容

- 新阻塞事件携带 code、source、关联执行 ID 和限长 message。自动失败生产者通过共享
  构造/校验入口生成它们。合法但尚无分类的异常明确写 unknown 并保留来源和摘要。
- `blockerReason` 保留供旧客户端读取，由当前阻塞事件的 message 投影。
  不在事件重放时查询当前会话来改写过去原因；投影必须可重复重建。
- 结构化字段随权威事件落盘；任务快照/summary 作为派生数据更新。
  是否需要数据库迁移取决于具体存储字段，不在设计阶段预设“无需迁移”。
- 历史事件不改写。读取时仅从同一执行的已记录证据生成 derived 诊断，并保留其出处。
  证据不足返回 legacy/unknown，不猜测为网络、鉴权或 CLI 故障。
- 独立提供只读扫描，统计缺原因记录并列出关联证据。需要持久修复时追加有审计的修复事件，
  不直接改快照，也不批量解除阻塞或启动任务。
- 列表使用批量查询生成摘要，详情再取证据。避免按每个任务逐一读取所有会话/日志。
  执行变更同时失效 task 与 session 缓存，继续使用现有 SSE 单调合并规则。

## 恢复与防重复执行

沿用 `/threads/{id}/execution/recovery` 保存重试、`/execution/reconcile` 人工释放和
任务 unblock 接口。第一阶段不增加“一键恢复并重新执行”。
unblock 仍只恢复记录阶段，之前 running 的任务回到 waiting_for_human。
明确区分「解除阻塞」「继续任务」「重新执行」的用户承诺。

后续如增加统一重试按钮，必须在后端现有 admission scope 内重新检查 owner/claim、
以幂等键提交并返回本次 runRequestId。不得由前端串联 unblock + start 来假装原子操作。
退出未知时禁止新执行；已有 terminal evidence 时优先完成保存。

## 实施顺序与验收

1. **先消除误导操作**：修正 unknown/unresponsive 的 reportGone 展示条件；补 phase×reason
   矩阵测试。未满足后端条件时只保留有效导航入口。
2. **补齐原因传递**：统一后端诊断投影、阻塞事件字段和能力判断；贯通 daemon、registry、
   session→task 投影与 summary/detail。覆盖缺原因、重复事件、过期 owner 和存储失败。
3. **接入现有恢复面板**：三种语言、明确标题、关联阻塞会话、按钮反馈和 SSE 更新。
   未知新 code、旧响应缺字段均能安全降级。
4. **修复已复现执行问题**：工作区 owner 不再等待其他 waiter 的状态通知；terminal outbox
   按实际尝试推进重放。将 follow-up 报告的独立复现迁入正常测试套件并验证由红转绿。
5. **历史诊断和观测**：只读扫描缺原因记录，监测 unknown 占比、最老未处理阻塞、恢复操作
   成功/拒绝原因、最老待发送 terminal event。任务/运行 ID 放日志中，不作为指标标签。

验收重点：

- 新自动阻塞均具有结构化原因或显式 unknown；重放不丢来源和关联 ID。
- blocked 不等于进程已退出；未知退出不能通过刷新、重复点击或重试绕过所有权检查。
- 同一阶段、同一用户下前端显示的操作与后端能力一致；状态变化后旧请求得到明确冲突响应。
- 保存重试不启动 CLI；解除阻塞不执行任务；人工释放有确认、有操作者、有权威审计事件。
- 两个现有阻塞复现由红转绿，且既有 lease、取消、终态持久化及串行工作区保证仍通过。
- 按变更范围运行聚焦测试、TypeScript 构建及完整 `npm test`；当前提案没有实施运行时代码。

相关审计：[执行阻塞 follow-up](testing/agent-execution-blockers-followup-2026-09-20.md)。
