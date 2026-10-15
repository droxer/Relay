import type { AgentName } from "../../types.ts";
import { claudeAssistantFrameId, parseClaude } from "./claude.ts";
import { parseCodex } from "./codex.ts";
import { parseKimi } from "./kimi.ts";
import { parsePi } from "./pi.ts";
import {
  isClaudeConnectorNotice,
  isCodexModelsCacheWarning,
  isCodexStdinNotice,
  streamRecords,
  stripAnsi,
} from "./records.ts";
import { type AgentSegment, narration } from "./segments.ts";

export function parseAgentStream(agent: AgentName, raw: string): AgentSegment[] {
  if (!raw) return [];
  if (agent === "claude") return parseClaude(raw);
  if (agent === "codex") return parseCodex(raw);
  if (agent === "pi") return parsePi(raw);
  if (agent === "kimi") return parseKimi(raw);
  return parsePlain(raw);
}

function parsePlain(raw: string): AgentSegment[] {
  const text = stripAnsi(raw).trimEnd();
  return text.trim() ? [{ kind: "text", text }] : [];
}

// stderr from a chatty CLI (progress bars, repeated deprecation warnings) can
// run to dozens of lines; the transcript keeps the tail — where the actual
// error usually lands — behind a single "omitted" line instead of a wall of
// warn rows.
const STDERR_TAIL_LINES = 3;

export function parseAgentStderr(raw: string): AgentSegment[] {
  if (!raw) return [];
  const lines = stripAnsi(raw).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line
      && !isCodexStdinNotice(line)
      && !isCodexModelsCacheWarning(line)
      && !isClaudeConnectorNotice(line))
    .filter((line, index, all) => line !== all[index - 1]);
  const tail = lines.slice(-STDERR_TAIL_LINES);
  const omitted = lines.length - tail.length;
  const out: AgentSegment[] = [];
  if (omitted > 0) out.push(narration("agent_stream.stderr_omitted", { count: omitted }, "warn"));
  for (const line of tail) out.push({ kind: "status", tone: "warn", text: line });
  return out;
}

const AGENT_CHECKPOINT_TYPES: Record<AgentName, "each" | ReadonlySet<unknown>> = {
  claude: new Set(["assistant", "result"]),
  codex: new Set(["turn.completed", "turn.failed"]),
  pi: new Set(["turn_end"]),
  kimi: "each",
};

type AgentCheckpoint = { end: number; value: Record<string, unknown> };

export function agentCheckpoints(agent: AgentName, raw: string, offset: number): AgentCheckpoint[] {
  const checkpoints: AgentCheckpoint[] = [];
  const policy = AGENT_CHECKPOINT_TYPES[agent];
  for (const record of streamRecords(raw.slice(offset))) {
    if (record.kind !== "json") continue;
    if (policy === "each" || policy.has(record.value.type)) {
      checkpoints.push({ end: offset + record.end, value: record.value });
    }
  }
  return checkpoints;
}

export function agentCheckpointId(agent: AgentName, event: Record<string, unknown>): string | undefined {
  if (agent !== "claude") return undefined;
  return claudeAssistantFrameId(event);
}
