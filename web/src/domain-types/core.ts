import type {
  CollaborationStyle,
  AgentName,
  AgentRole,
  AgentRuntimeStatus,
  ControlPanelDaemonNodeRecord,
  DaemonAgentInventory,
  DaemonAgentMcpServer,
  DaemonAgentSkill,
  DaemonMcpTransport,
  DaemonNodeMonitorRecord,
  RelayArtifact,
  RelayTask,
  RelayTaskEvent,
  RelayTaskListItem,
  RelayTaskSummary,
  RelaySession,
  SandboxRecord,
  SessionStatus,
  TaskPriority,
  RoutineOccurrenceTriggerKind,
  RoutinePauseReason,
  RoutineSchedule,
  RoutineState,
  ScheduleRepeat,
  RoutineTrigger,
  RoutineTriggerKind,
  RoutineTriggerOn,
  RoutineTriggerFilters,
  TaskStatus,
  TokenUsage,
} from "relay-core";

export type {
  CollaborationStyle,
  AgentName,
  AgentRole,
  AgentRuntimeStatus,
  ControlPanelDaemonNodeRecord,
  DaemonAgentInventory,
  DaemonAgentMcpServer,
  DaemonAgentSkill,
  DaemonMcpTransport,
  DaemonNodeMonitorRecord,
  RelayArtifact,
  RelayTask,
  RelayTaskEvent,
  RelayTaskListItem,
  RelayTaskSummary,
  RelaySession,
  SandboxRecord,
  SessionStatus,
  TaskPriority,
  RoutineOccurrenceTriggerKind,
  RoutinePauseReason,
  RoutineSchedule,
  RoutineState,
  ScheduleRepeat,
  RoutineTrigger,
  RoutineTriggerKind,
  RoutineTriggerOn,
  RoutineTriggerFilters,
  TaskStatus,
  TokenUsage,
};

/**
 * Canonical agent ordering for web surfaces. Mirrors AGENT_REGISTRY in
 * relay-core/src/agents.ts (which isn't importable here because web bundles
 * can't pull node-only modules — see AGENTS.md). Update both when adding an
 * agent.
 */
export const AGENT_NAMES: AgentName[] = ["claude", "pi", "codex", "kimi"];

/** Single tone vocabulary for every status surface (toasts, pills, dots, stream status, system rows). */
export type Tone = "good" | "bad" | "warn" | "info" | "neutral";
