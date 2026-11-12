import type { DaemonNodeRunCommand, DaemonNodeEvent, TokenUsage } from 'relay-core';
import type { DaemonLogFields } from './index.js';

export function commandLogFields(sandboxId: string, command: DaemonNodeRunCommand): DaemonLogFields {
  return {
    sandboxId,
    commandId: command.id,
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
  };
}

export function commandLeaseEventFields(command: DaemonNodeRunCommand): { leaseId?: string } {
  return command.leaseId ? { leaseId: command.leaseId } : {};
}

export function runCancelledEvent(
  command: DaemonNodeRunCommand,
  reason: unknown,
  agentLog?: string,
  tokenUsage?: TokenUsage,
  runtimeSessionId?: string,
): DaemonNodeEvent {
  return {
    type: "run.cancelled",
    commandId: command.id,
    ...commandLeaseEventFields(command),
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
    reason: typeof reason === "string" && reason ? reason : "Cancelled by human.",
    ...(agentLog ? { agentLog } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
  };
}
