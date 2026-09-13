import type { TFunction } from "i18next";
import type { CodexCollaborationEvent, RelayArtifact } from "relay-core";
import type { AgentName, RelaySession, TokenUsage, Tone } from "../types.js";

export type DerivedMessage =
  | {
      kind: "user";
      id: string;
      timestamp: string;
      text: string;
    }
  | {
      kind: "agent";
      id: string;
      timestamp: string;
      agent: AgentName;
      /** Logical (employee) agent that produced the turn. `agent` is only the
       * executor kind, which several named agents can share. */
      agentId?: string;
      runId: string;
      streaming: boolean;
      stdout: string;
      stderr: string;
      collaborations: CodexCollaborationEvent[];
      attachments: RelayArtifact[];
      /** Token usage reported by the run on completion; shown at the foot of
       * the agent turn. */
      tokenUsage?: TokenUsage;
    }
  | {
      kind: "system";
      id: string;
      timestamp: string;
      tone: Tone;
      label: string;
      detail?: string;
      /** Set for artifacts that arrive outside an agent run (e.g. plans),
       * so the transcript can render the artifact card instead of a bare
       * label line. */
      artifact?: RelayArtifact;
    };

type AgentTurn = Extract<DerivedMessage, { kind: "agent" }>;

/** Same speaker across two turns. Named agents are compared by logical id when
 * both turns carry one — two agents can share an executor kind — and by
 * executor kind otherwise, so legacy runs still group as before. */
export function isSameAgentTurn(left: AgentTurn, right: AgentTurn): boolean {
  if (left.agentId && right.agentId) return left.agentId === right.agentId;
  return left.agent === right.agent;
}

export function isGroupedContinuation(messages: DerivedMessage[], index: number): boolean {
  const message = messages[index];
  if (message.kind !== "agent") return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = messages[i];
    if (prev.kind === "system") continue;
    return prev.kind === "agent" && isSameAgentTurn(prev, message);
  }
  return false;
}

function previousTranscriptTurn(messages: DerivedMessage[], index: number): DerivedMessage | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = messages[i];
    if (prev.kind !== "system") return prev;
  }
  return undefined;
}

/** Label for a phase divider when the transcript hands work to another agent. */
export function phaseDividerLabel(
  messages: DerivedMessage[],
  index: number,
  t: TFunction,
): string | null {
  const message = messages[index];
  if (message.kind !== "agent" || isGroupedContinuation(messages, index)) return null;

  const prev = previousTranscriptTurn(messages, index);
  if (!prev) return null;

  if (prev.kind === "agent" && !isSameAgentTurn(prev, message)) {
    return t("transcript.phase_handoff");
  }
  return null;
}

// A JSONL line carrying an agent-protocol envelope. Used to place an agent log
// that arrived without stream markers: stream records are the agent's own
// output, so filing them as stderr would render a healthy run as a wall of
// warnings.
function looksLikeAgentStream(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && "type" in (value as Record<string, unknown>)) return true;
    } catch {
      // Not a complete JSON line; keep looking.
    }
  }
  return false;
}

function streamsFromAgentLog(agentLog: string): { stdout: string; stderr: string } {
  if (!agentLog.trim()) return { stdout: "", stderr: "" };
  const matches = Array.from(agentLog.matchAll(/(?:^|\n)(stdout|stderr):\n/g));
  if (matches.length === 0) {
    return looksLikeAgentStream(agentLog)
      ? { stdout: agentLog, stderr: "" }
      : { stdout: "", stderr: agentLog };
  }

  const streams = { stdout: "", stderr: "" };
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const stream = match[1] as "stdout" | "stderr";
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index ?? agentLog.length : agentLog.length;
    streams[stream] += agentLog.slice(contentStart, contentEnd);
  }
  return streams;
}

function appendMissingStream(current: string, fallback: string): string {
  if (!fallback.trim()) return current;
  const trimmed = fallback.trim();
  if (current.includes(fallback) || current.includes(trimmed)) return current;
  const separator = current && !current.endsWith("\n") && !fallback.startsWith("\n") ? "\n" : "";
  return `${current}${separator}${fallback}`;
}

function safeJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recordText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object") return "";
      const item = chunk as Record<string, unknown>;
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function visibleLogText(stdout: string, stderr: string): string {
  const lines = stdout.split(/\r?\n/);
  const text: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = safeJsonLine(line);
    if (!event) {
      text.push(line);
      continue;
    }
    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : {};
      if (item.type === "agent_message" && event.type === "item.completed") {
        const itemText = recordText(item).trim();
        if (itemText) text.push(itemText);
      }
      continue;
    }
    if (event.type === "assistant") {
      const messageText = recordText(event.message).trim();
      if (messageText) text.push(messageText);
      continue;
    }
    // Claude's terminal result frame can be the only record carrying the
    // response. Count it as visible so completed-log fallback preserves the
    // frame for AgentStream instead of treating the run as empty.
    if (event.type === "result") {
      const resultText = typeof event.result === "string" ? event.result.trim() : "";
      if (resultText) text.push(resultText);
      continue;
    }
    if (event.type === "message" || event.type === "assistant_message" || event.role === "assistant") {
      const message = event.message && typeof event.message === "object" ? event.message : event;
      const messageText = recordText(message).trim();
      if (messageText) text.push(messageText);
    }
  }
  return [...text, stderr.trim()].filter(Boolean).join("\n").trim();
}

function applyCompletedLogFallback(state: { stdout: string; stderr: string }, agentLog: string): void {
  const fallback = streamsFromAgentLog(agentLog);
  const fallbackVisible = visibleLogText(fallback.stdout, fallback.stderr);
  if (!fallbackVisible) return;
  const currentVisible = visibleLogText(state.stdout, state.stderr);
  if (currentVisible.includes(fallbackVisible)) return;
  state.stdout = appendMissingStream(state.stdout, fallback.stdout);
  state.stderr = appendMissingStream(state.stderr, fallback.stderr);
}

type RunProjectionState = {
  index: number;
  attachmentIds: Set<string>;
  stdout: string;
  stderr: string;
  collaborations: CodexCollaborationEvent[];
};

/** Incrementally materialize only the event suffix appended since the last render. */
export class ProjectMessagesAccumulator {
  private sessionId: string | undefined;
  private taskGoal = "";
  private createdAt = "";
  private translator: TFunction | undefined;
  private processedEvents = 0;
  private lastEventId: string | undefined;
  private out: DerivedMessage[] = [];
  private snapshot: DerivedMessage[] = [];
  private readonly runState = new Map<string, RunProjectionState>();

  update(session: RelaySession | undefined, t: TFunction): DerivedMessage[] {
    if (!session) {
      this.clear();
      return [];
    }
    const appendOnly = this.sessionId === session.id
      && this.taskGoal === session.taskGoal
      && this.createdAt === session.createdAt
      && this.translator === t
      && this.processedEvents <= session.events.length
      && (this.processedEvents === 0 || session.events[this.processedEvents - 1]?.id === this.lastEventId);
    if (!appendOnly) this.initialize(session, t);

    let changed = !appendOnly;
    for (let index = this.processedEvents; index < session.events.length; index += 1) {
      changed = this.applyEvent(session.events[index], t) || changed;
    }
    this.processedEvents = session.events.length;
    this.lastEventId = session.events.at(-1)?.id;
    if (changed) this.snapshot = [...this.out];
    return this.snapshot;
  }

  private initialize(session: RelaySession, t: TFunction): void {
    this.sessionId = session.id;
    this.taskGoal = session.taskGoal;
    this.createdAt = session.createdAt;
    this.translator = t;
    this.processedEvents = 0;
    this.lastEventId = undefined;
    this.runState.clear();
    this.out = [{
      kind: "user",
      id: `${session.id}:goal`,
      timestamp: session.createdAt,
      text: session.taskGoal,
    }];
    this.snapshot = [...this.out];
  }

  private clear(): void {
    this.sessionId = undefined;
    this.taskGoal = "";
    this.createdAt = "";
    this.translator = undefined;
    this.processedEvents = 0;
    this.lastEventId = undefined;
    this.runState.clear();
    this.out = [];
    this.snapshot = [];
  }

  private ensureRun(
    runId: string,
    agent: AgentName,
    timestamp: string,
  ): { index: number; created: boolean } {
    const existing = this.runState.get(runId);
    if (existing) return { index: existing.index, created: false };
    this.out.push({
      kind: "agent",
      id: `${this.sessionId}:run:${runId}`,
      timestamp,
      agent,
      runId,
      streaming: true,
      stdout: "",
      stderr: "",
      collaborations: [],
      attachments: [],
    });
    const index = this.out.length - 1;
    this.runState.set(runId, {
      index,
      attachmentIds: new Set(),
      stdout: "",
      stderr: "",
      collaborations: [],
    });
    return { index, created: true };
  }

  private applyEvent(event: RelaySession["events"][number], t: TFunction): boolean {
    switch (event.type) {
      case "system.notice":
        this.out.push({
          kind: "system",
          id: event.id,
          timestamp: event.timestamp,
          tone: "warn",
          label: t("message.skills_skipped", { defaultValue: "Some managed skills were skipped" }),
          detail: event.skillsSkipped.map((skill) => `${skill.slug ?? skill.skillId}: ${t(`skills.skip_reason.${skill.reason}`, { defaultValue: skill.reason })}`).join("; ") || event.text,
        });
        return true;
      case "session.created":
      case "session.status":
      case "session.completed":
      case "session.failed":
        return false;
      case "user.message":
        this.out.push({ kind: "user", id: event.id, timestamp: event.timestamp, text: event.text });
        return true;
      case "agent.started": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const block = this.out[ensured.index];
        if (block.kind === "agent" && block.agentId !== event.logicalAgentId) {
          this.out[ensured.index] = {
            ...block,
            ...(event.logicalAgentId ? { agentId: event.logicalAgentId } : {}),
          };
          return true;
        }
        return ensured.created;
      }
      case "agent.output": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const state = this.runState.get(event.runId);
        if (!state) return ensured.created;
        if (event.stream === "stdout") state.stdout += event.text;
        else state.stderr += event.text;
        const block = this.out[ensured.index];
        if (block.kind === "agent") {
          this.out[ensured.index] = { ...block, stdout: state.stdout, stderr: state.stderr };
          return true;
        }
        return ensured.created;
      }
      case "agent.output.batch": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const state = this.runState.get(event.runId);
        if (!state) return ensured.created;
        for (const entry of event.entries) {
          if (entry.stream === "stdout") state.stdout += entry.text;
          else state.stderr += entry.text;
        }
        const block = this.out[ensured.index];
        if (block.kind === "agent") {
          this.out[ensured.index] = { ...block, stdout: state.stdout, stderr: state.stderr };
          return true;
        }
        return ensured.created;
      }
      case "agent.collaboration": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const state = this.runState.get(event.runId);
        if (!state) return ensured.created;
        state.collaborations.push(event.collaboration);
        const block = this.out[ensured.index];
        if (block.kind === "agent") {
          this.out[ensured.index] = { ...block, collaborations: [...state.collaborations] };
          return true;
        }
        return ensured.created;
      }
      case "artifact.created": {
        if (event.artifact.kind === "command_log") return false;
        const runId = event.artifact.agentRunId;
        const state = runId ? this.runState.get(runId) : undefined;
        if (runId && state) {
          const block = this.out[state.index];
          if (!state.attachmentIds.has(event.artifact.id) && block.kind === "agent") {
            state.attachmentIds.add(event.artifact.id);
            this.out[state.index] = { ...block, attachments: [...block.attachments, event.artifact] };
            return true;
          }
          return false;
        }
        this.out.push({
          kind: "system",
          id: event.id,
          timestamp: event.timestamp,
          tone: "neutral",
          label: t("message.artifact", { kind: t(`artifact.kind.${event.artifact.kind}`, { defaultValue: event.artifact.kind }) }),
          detail: event.artifact.title,
          artifact: event.artifact,
        });
        return true;
      }
      case "human.decision":
        this.out.push({
          kind: "system",
          id: event.id,
          timestamp: event.timestamp,
          tone: "info",
          label: t("message.decision", { kind: t(`decision.${event.decision.kind}`, { defaultValue: event.decision.kind }) }),
          detail: event.decision.kind === "cancel" ? t("message.cancelled") : event.decision.note,
        });
        return true;
      case "agent.completed": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const state = this.runState.get(event.runId);
        if (!state) return ensured.created;
        if (event.agentLog) applyCompletedLogFallback(state, event.agentLog);
        const block = this.out[ensured.index];
        if (block.kind !== "agent") return ensured.created;
        this.out[ensured.index] = {
          ...block,
          streaming: false,
          stdout: state.stdout,
          stderr: state.stderr,
          ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
        };
        return true;
      }
      default:
        return false;
    }
  }
}

export function projectMessages(session: RelaySession | undefined, t: TFunction): DerivedMessage[] {
  return new ProjectMessagesAccumulator().update(session, t);
}
