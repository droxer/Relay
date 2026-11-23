import type { TFunction } from "i18next";
import type { CodexCollaborationEvent, RelayArtifact, RunFollowUp } from "relay-core";
import type { AgentName, RelaySession, TokenUsage, Tone } from "../types.js";
import { permissionInputSummary } from "./permissionRequests.ts";
import { toolInput, toolTarget } from "./agent-stream/builders.ts";
import { agentMessagePlainText } from "./agent-stream/display.ts";

/** How a runtime permission prompt closed, as the turn that asked shows it:
 *  on the tool line it covered, or as its own line in the turn when no line
 *  matches. */
export type PermissionAudit = {
  id: string;
  toolName: string;
  /** The runtime's id for the tool call, when it sent one. */
  toolUseId?: string;
  /** The tool line's target (`toolTarget`) the prompt covered. */
  target?: string;
  outcome: "allow" | "allow_always" | "allow_granted" | "allow_yolo" | "deny" | "expired" | "answered" | "skipped";
  tone: Tone;
  label: string;
  detail?: string;
};

export type DerivedMessage =
  | {
      kind: "user";
      attachments?: import("relay-core").ThreadImageAttachment[];
      id: string;
      timestamp: string;
      text: string;
      /** Sent into a running turn (`user.live_message`) rather than opening a new one. */
      live?: boolean;
    }
  | {
      kind: "agent";
      id: string;
      timestamp: string;
      agent: AgentName;
      /** Logical (user) agent that produced the turn. `agent` is only the
       * executor kind, which several named agents can share. */
      agentId?: string;
      runId: string;
      /** Relay started this turn to rerun the same step (asking for a missing
       * report, or retrying a failure); it is its own turn, never more of the
       * answer above it. */
      followUp?: RunFollowUp;
      streaming: boolean;
      stdout: string;
      stderr: string;
      collaborations: CodexCollaborationEvent[];
      /** Permission prompts this run raised and how each closed. */
      permissions?: PermissionAudit[];
      attachments: RelayArtifact[];
      /** Token usage reported by the run on completion; shown at the foot of
       * the agent turn. */
      tokenUsage?: TokenUsage;
      /** The run finished but its runtime reported no counts, so the foot
       * says so rather than looking like a turn that cost nothing. */
      usageUnreported?: boolean;
      /** Part of the live output never reached Relay; the result is complete. */
      outputTruncated?: boolean;
      /** The turn stopped before finishing and its runtime can pick it back up. */
      resumable?: boolean;
      /** How the run ended, when, and with what exit code — set on completion
       * and read by the turn's receipt (runReceipt.ts). */
      outcome?: "completed" | "failed" | "cancelled";
      finishedAt?: string;
      exitCode?: number;
      /** A live message cut this run: this block holds its output up to the
       * message, and the run continues in a later block after it. */
      continued?: boolean;
      /** When the run began, on a block that continues it after a live
       * message (whose own timestamp is the message's). */
      runStartedAt?: string;
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
function isSameAgentTurn(left: AgentTurn, right: AgentTurn): boolean {
  if (left.agentId && right.agentId) return left.agentId === right.agentId;
  return left.agent === right.agent;
}

export function isGroupedContinuation(messages: DerivedMessage[], index: number): boolean {
  const message = messages[index];
  if (message.kind !== "agent" || message.followUp) return false;
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

/** The previous agent's turn when this turn takes work over from another
 * agent — the source of a handoff — or undefined for any other turn. */
export function handoffSource(
  messages: DerivedMessage[],
  index: number,
): Extract<DerivedMessage, { kind: "agent" }> | undefined {
  const message = messages[index];
  if (message?.kind !== "agent") return undefined;
  const prev = previousTranscriptTurn(messages, index);
  return prev?.kind === "agent" && !isSameAgentTurn(prev, message) ? prev : undefined;
}

/** Label for a phase divider when the transcript hands work to another agent. */
export function phaseDividerLabel(
  messages: DerivedMessage[],
  index: number,
  t: TFunction,
): string | null {
  const message = messages[index];
  if (message.kind !== "agent" || isGroupedContinuation(messages, index)) return null;

  return handoffSource(messages, index) ? t("transcript.phase_handoff") : null;
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
  if (fallback.includes(current)) return fallback;
  const separator = current && !current.endsWith("\n") && !fallback.startsWith("\n") ? "\n" : "";
  return `${current}${separator}${fallback}`;
}

/** How a prompt closed: a person's allow once or always, a standing grant's
 *  allow, a deny, or an expiry — for a question, answered or skipped. */
function permissionOutcome(
  event: { decision: string; always?: boolean; grant?: boolean; permissionMode?: "yolo" },
  question: boolean,
): PermissionAudit["outcome"] {
  if (question) return event.decision === "allow" ? "answered" : event.decision === "deny" ? "skipped" : "expired";
  if (event.decision === "allow" && event.permissionMode === "yolo") return "allow_yolo";
  if (event.decision === "allow" && event.grant) return "allow_granted";
  if (event.decision === "allow" && event.always) return "allow_always";
  return event.decision === "deny" ? "deny" : event.decision === "allow" ? "allow" : "expired";
}

type OpenPrompt = {
  runId: string;
  toolName: string;
  toolUseId?: string;
  question: boolean;
  summary?: string;
  target?: string;
};

function applyCompletedLogFallback(
  state: RunStreams, fallback: RunStreams, agent: AgentName, t: TFunction,
): void {
  if (!state.stdout.includes(fallback.stdout.trim())) {
    const fallbackText = agentMessagePlainText(agent, fallback.stdout, "", t);
    if (fallbackText && !agentMessagePlainText(agent, state.stdout, "", t).includes(fallbackText)) {
      state.stdout = appendMissingStream(state.stdout, fallback.stdout);
    }
  }
  state.stderr = appendMissingStream(state.stderr, fallback.stderr);
}

type RunStreams = { stdout: string; stderr: string };

type RunProjectionState = RunStreams & {
  /** The run's current (latest) block. */
  index: number;
  attachmentIds: Set<string>;
  /** The run's whole output; its current block shows it from the offsets. */
  stdoutStart: number;
  stderrStart: number;
  collaborations: CodexCollaborationEvent[];
  /** Reconcile late output against the stream before adding log recovery text. */
  completedOutput?: { streamed: RunStreams; fallback: RunStreams };
};

function segmentStreams(state: RunProjectionState): { stdout: string; stderr: string } {
  return { stdout: state.stdout.slice(state.stdoutStart), stderr: state.stderr.slice(state.stderrStart) };
}

/** Where a new block may start: after the last complete line, so a JSONL
 * record streamed in halves never splits across two blocks. */
function lineBoundary(text: string, from: number): number {
  return Math.max(from, text.lastIndexOf("\n") + 1);
}

/** The block offset after the completed-log fallback rewrote a stream. */
function rebaseOffset(before: string, after: string, start: number): number {
  if (start === 0 || before === after) return start;
  const prefix = before.slice(0, start);
  if (after.startsWith(prefix)) return start;
  const at = after.indexOf(prefix);
  return at >= 0 ? at + prefix.length : Math.min(start, after.length);
}

function reconcileCompletedOutput(state: RunProjectionState, agent: AgentName, t: TFunction): void {
  const completed = state.completedOutput;
  if (!completed) return;
  const output = { ...completed.streamed };
  applyCompletedLogFallback(output, completed.fallback, agent, t);
  state.stdoutStart = rebaseOffset(state.stdout, output.stdout, state.stdoutStart);
  state.stderrStart = rebaseOffset(state.stderr, output.stderr, state.stderrStart);
  Object.assign(state, output);
}

/** Incrementally materialize only the event suffix appended since the last render. */
export class ProjectMessagesAccumulator {
  private sessionId: string | undefined;
  private taskGoal = "";
  private createdAt = "";
  private translator: TFunction | undefined;
  private processedEvents = 0;
  private lastEventId: string | undefined;
  private eventStart: number | undefined;
  private transcriptRevision: string | undefined;
  private out: DerivedMessage[] = [];
  private snapshot: DerivedMessage[] = [];
  private readonly runState = new Map<string, RunProjectionState>();
  /** Open permission prompts by id: the resolution names only the id. */
  private readonly prompts = new Map<string, OpenPrompt>();

  /** Derive the next projection without changing this committed accumulator. */
  advance(session: RelaySession | undefined, t: TFunction): { accumulator: ProjectMessagesAccumulator; messages: DerivedMessage[] } {
    const next = new ProjectMessagesAccumulator();
    next.sessionId = this.sessionId;
    next.taskGoal = this.taskGoal;
    next.createdAt = this.createdAt;
    next.translator = this.translator;
    next.processedEvents = this.processedEvents;
    next.lastEventId = this.lastEventId;
    next.eventStart = this.eventStart;
    next.transcriptRevision = this.transcriptRevision;
    next.out = [...this.out];
    next.snapshot = this.snapshot;
    for (const [requestId, prompt] of this.prompts) next.prompts.set(requestId, prompt);
    for (const [runId, state] of this.runState) {
      next.runState.set(runId, {
        ...state,
        attachmentIds: new Set(state.attachmentIds),
        collaborations: [...state.collaborations],
      });
    }
    return { accumulator: next, messages: next.update(session, t) };
  }

  update(session: RelaySession | undefined, t: TFunction): DerivedMessage[] {
    if (!session) {
      this.clear();
      return [];
    }
    const appendOnly = this.sessionId === session.id
      && this.taskGoal === session.taskGoal
      && this.createdAt === session.createdAt
      && this.eventStart === session.eventStart
      && this.transcriptRevision === session.transcriptRevision
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
    this.eventStart = session.eventStart;
    this.transcriptRevision = session.transcriptRevision;
    this.runState.clear();
    this.prompts.clear();
    const attachments = session.events.find(event => event.type === "session.created")?.attachments;
    this.out = !session.eventStart && (session.taskGoal || attachments?.length) ? [{
      kind: "user",
      id: `${session.id}:goal`,
      timestamp: session.createdAt,
      text: session.taskGoal,
      attachments,
    }] : [];
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
    this.prompts.clear();
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
      stdoutStart: 0,
      stderrStart: 0,
      collaborations: [],
    });
    return { index, created: true };
  }

  /** A live message reached a run mid-turn: what the run says next answers
   * it, so the run's output continues in a new block after the message
   * instead of growing the block above it. */
  private continueRunAfterLiveMessage(runId: string, eventId: string, timestamp: string): void {
    const state = this.runState.get(runId);
    const block = state ? this.out[state.index] : undefined;
    if (!state || block?.kind !== "agent" || !block.streaming) return;
    const stdoutStart = lineBoundary(state.stdout, state.stdoutStart);
    const stderrStart = lineBoundary(state.stderr, state.stderrStart);
    this.out[state.index] = {
      ...block,
      streaming: false,
      continued: true,
      stdout: state.stdout.slice(state.stdoutStart, stdoutStart),
      stderr: state.stderr.slice(state.stderrStart, stderrStart),
    };
    state.stdoutStart = stdoutStart;
    state.stderrStart = stderrStart;
    state.collaborations = [];
    this.out.push({
      kind: "agent",
      id: `${this.sessionId}:run:${runId}:after:${eventId}`,
      timestamp,
      agent: block.agent,
      ...(block.agentId ? { agentId: block.agentId } : {}),
      runId,
      runStartedAt: block.runStartedAt ?? block.timestamp,
      streaming: true,
      ...segmentStreams(state),
      collaborations: [],
      attachments: [],
    });
    state.index = this.out.length - 1;
  }

  private permissionAudit(
    event: Extract<RelaySession["events"][number], { type: "agent.permission_resolved" }>,
    prompt: OpenPrompt,
    t: TFunction,
  ): PermissionAudit {
    const outcome = permissionOutcome(event, prompt.question);
    const answers = Object.values(event.answers ?? {}).map((picks) => picks.join(", ")).join(" · ");
    return {
      id: event.id,
      toolName: prompt.toolName,
      ...(prompt.toolUseId ? { toolUseId: prompt.toolUseId } : {}),
      ...(prompt.target ? { target: prompt.target } : {}),
      outcome,
      tone: event.decision === "allow" ? "info" : event.decision === "deny" ? "warn" : "neutral",
      label: t(`message.permission_${outcome}`, { tool: prompt.toolName }),
      // Name what was allowed — the command, the file — not only the tool.
      detail: prompt.question
        ? (event.decision === "allow" && answers ? answers : event.note)
        : [prompt.summary, event.note].filter(Boolean).join(" · ") || undefined,
    };
  }

  private appendRunOutput(
    event: Extract<RelaySession["events"][number], { type: "agent.output" | "agent.output.batch" }>,
    t: TFunction,
  ): boolean {
    const { index, created } = this.ensureRun(event.runId, event.agent, event.timestamp);
    const state = this.runState.get(event.runId);
    if (!state) return created;
    const entries = event.type === "agent.output" ? [event] : event.entries;
    const completed = state.completedOutput;
    const output = completed ? { ...completed.streamed } : state;
    for (const entry of entries) output[entry.stream] += entry.text;
    if (completed) {
      state.completedOutput = { ...completed, streamed: output };
      reconcileCompletedOutput(state, event.agent, t);
    }
    const block = this.out[index];
    const streams = segmentStreams(state);
    if (block.kind === "agent" && (block.stdout !== streams.stdout || block.stderr !== streams.stderr)) {
      this.out[index] = { ...block, ...streams };
      return true;
    }
    return created;
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
        this.out.push({ kind: "user", id: event.id, timestamp: event.timestamp, text: event.text, ...(event.attachments?.length ? { attachments: event.attachments } : {}) });
        return true;
      case "user.live_message":
        // Said to a run while it worked: the person's words, marked as reaching that run live.
        this.out.push({ kind: "user", id: event.id, timestamp: event.timestamp, text: event.text, live: true });
        this.continueRunAfterLiveMessage(event.runId, event.id, event.timestamp);
        return true;
      case "agent.started": {
        const ensured = this.ensureRun(event.runId, event.agent, event.timestamp);
        const block = this.out[ensured.index];
        if (block.kind === "agent" && (block.agentId !== event.logicalAgentId || block.followUp !== event.followUp)) {
          this.out[ensured.index] = {
            ...block,
            ...(event.logicalAgentId ? { agentId: event.logicalAgentId } : {}),
            ...(event.followUp ? { followUp: event.followUp } : {}),
          };
          return true;
        }
        return ensured.created;
      }
      case "agent.output":
      case "agent.output.batch":
        return this.appendRunOutput(event, t);
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
        // A recent transcript window can hold a file event before the reader
        // has loaded its producing turn. Its entry is already in Files.
        if (this.eventStart && runId && event.artifact.kind === "workspace_file") return false;
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
      case "agent.permission_requested": {
        const question = (event.request.questions?.length ?? 0) > 0;
        this.prompts.set(event.request.id, {
          runId: event.request.runId,
          toolName: event.request.toolName,
          ...(event.request.toolUseId ? { toolUseId: event.request.toolUseId } : {}),
          question,
          summary: question ? undefined : permissionInputSummary(event.request.input),
          target: toolTarget(toolInput(event.request.input)),
        });
        return false;
      }
      case "agent.permission_resolved": {
        // The audit of a prompt: who allowed what, or that nobody did. It
        // joins the turn that asked, beside the tool line it covered.
        const prompt = this.prompts.get(event.requestId);
        if (!prompt) return false;
        this.prompts.delete(event.requestId);
        const audit = this.permissionAudit(event, prompt, t);
        const state = this.runState.get(prompt.runId);
        const block = state ? this.out[state.index] : undefined;
        if (block?.kind === "agent") {
          this.out[state!.index] = { ...block, permissions: [...(block.permissions ?? []), audit] };
          return true;
        }
        this.out.push({
          kind: "system",
          id: event.id,
          timestamp: event.timestamp,
          tone: audit.tone,
          label: audit.label,
          detail: audit.detail,
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
        if (event.agentLog) {
          state.completedOutput = {
            streamed: state.completedOutput?.streamed ?? { stdout: state.stdout, stderr: state.stderr },
            fallback: streamsFromAgentLog(event.agentLog),
          };
          reconcileCompletedOutput(state, event.agent, t);
        }
        const block = this.out[state.index];
        if (block.kind !== "agent") return ensured.created;
        this.out[state.index] = {
          ...block,
          streaming: false,
          ...segmentStreams(state),
          ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
          ...(!event.tokenUsage ? { usageUnreported: true } : {}),
          ...(event.outputTruncated ? { outputTruncated: true } : {}),
          ...(event.status !== "completed" && event.runtimeSessionId ? { resumable: true } : {}),
          outcome: event.status === "running" ? "completed" : event.status,
          finishedAt: event.timestamp,
          ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
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
