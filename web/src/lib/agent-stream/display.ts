import type { TFunction } from "i18next";
import type { AgentName } from "../../types.ts";
import { normalizeOverEscapedQuotes } from "../markdown.ts";
import { parseAgentStderr, parseAgentStream } from "./parse.ts";
import type { AgentSegment } from "./segments.ts";

/** Stable React keys for a rendered segment list.
 *
 * Segments carry no key of their own, and a bare kind + occurrence counter ties
 * a row to its *position*: insert one segment mid-stream and every later row of
 * that kind inherits the previous row's component state — an expanded command
 * would collapse and its neighbour would open. Where the CLI gave the call an
 * id, that id is the identity; the ordinal remains the fallback for segments
 * (prose, reasoning, status) that never had one.
 */
export function segmentKeys(segments: AgentSegment[]): string[] {
  const kindCounts = new Map<string, number>();
  const keyCounts = new Map<string, number>();
  return segments.map((segment) => {
    const seen = kindCounts.get(segment.kind) ?? 0;
    kindCounts.set(segment.kind, seen + 1);
    const id = "id" in segment ? segment.id : undefined;
    const base = id ? `${segment.kind}#${id}` : `${segment.kind}-${seen}`;
    // A CLI reuses a call id across turns (`call_1` twice in one transcript),
    // so the id alone is not unique over a whole run — two rows would collide
    // on one React key. Repeats get an occurrence suffix; the first keeps the
    // bare key so the common case stays readable.
    const repeats = keyCounts.get(base) ?? 0;
    keyCounts.set(base, repeats + 1);
    return repeats === 0 ? base : `${base}@${repeats}`;
  });
}

export function userVisibleAgentSegments(segments: AgentSegment[]): AgentSegment[] {
  const visible = segments.filter(
    (segment) => segment.kind === "text" || segment.kind === "status" || segment.kind === "narration",
  );
  // Raw fallback output (CLI text the parser could not classify) is elided
  // once a run settles — unless it is the only substance, in which case
  // dropping it would leave the turn reading as empty.
  if (visible.some((segment) => segment.kind === "text")) return visible;
  if (!segments.some((segment) => segment.kind === "raw")) return visible;
  return segments.filter(
    (segment) =>
      segment.kind === "text" ||
      segment.kind === "status" ||
      segment.kind === "narration" ||
      segment.kind === "raw",
  );
}

// A settled turn can carry thousands of characters of reasoning — one recorded
// Claude run produced 14187 with no prose at all — which would bury the answer
// it was reasoning towards. Settled reasoning therefore collapses behind a
// single header row, the way every current agent surface presents it.
//
// The header is not a generic "Show reasoning": that hides an unknown quantity
// of unknown text, and a turn with several such rows is a column of identical
// controls. Reasoning summaries carry their own structure — Codex writes each
// step as a bold title with an optional body, verified against a recorded run
// — so the header names the step and counts the rest, and the expanded body
// renders those titles as titles instead of leaving `**` in the transcript.
//
// Live reasoning is the exception to collapsing: while the block is the one
// still growing it stays open, because a run can spend minutes reasoning
// before it writes a word and collapsing that leaves the turn blank. Its
// header names the step the agent is on now. It closes on its own once the run
// settles, unless the reader has taken the disclosure over by then.

/** One step of a reasoning summary: its title, and the body lines under it. */
type ReasoningSection = {
  /** The step's own title, or `null` for reasoning that arrived untitled. */
  title: string | null;
  lines: string[];
};

// A line that is nothing but bold text, or a markdown heading, is a step title
// rather than a sentence. Anything else is body — including a line that merely
// *starts* with a bold run, which is ordinary emphasis mid-thought.
const REASONING_TITLE = /^(?:\*\*(.+?)\*\*|#{1,6}\s+(.+?))\s*$/;

/** Split reasoning text into its steps. */
export function reasoningOutline(text: string): ReasoningSection[] {
  const sections: ReasoningSection[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const title = REASONING_TITLE.exec(trimmed);
    if (title) {
      sections.push({ title: (title[1] ?? title[2] ?? "").trim(), lines: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    // Body that arrives before any title — all of Claude's thinking, and the
    // opening of a summary that starts mid-sentence — opens an untitled step.
    if (!current) {
      sections.push({ title: null, lines: [trimmed] });
      continue;
    }
    current.lines.push(trimmed);
  }
  return sections;
}

type ReasoningSummary = {
  /** The one line the collapsed header shows. */
  label: string;
  /** Titled steps in the block — 0 when the reasoning carried no titles. */
  steps: number;
};

/** The header line for a reasoning block.
 *
 * A live block is reporting progress, so it names the step the agent is on
 * now; a settled one is a record, so it names where the thinking started and
 * lets the count carry its length. Reasoning with no titles of its own falls
 * back to the same end of its own text. */
export function reasoningSummary(
  sections: ReasoningSection[],
  { live }: { live: boolean },
): ReasoningSummary {
  const steps = sections.filter((section) => section.title !== null).length;
  const ordered = live ? [...sections].reverse() : sections;
  const titled = ordered.find((section) => section.title !== null);
  if (titled?.title) return { label: titled.title, steps };
  const lines = ordered.flatMap((section) => (live ? [...section.lines].reverse() : section.lines));
  return { label: lines[0] ?? "", steps };
}

/** Command lines shown before the rest collapses behind a toggle.
 *
 * A `command` segment is one shell invocation, but an agent that writes a file
 * with `cat > file << 'EOF'` puts the whole file inside that invocation — runs
 * of hundreds of lines that push the answer off the screen. Six lines is
 * enough to read what the command is doing; the body opens on a click. */
const COMMAND_PREVIEW_LINES = 6;

type CommandDisplay = {
  lines: string[];
  /** Lines withheld from the preview — 0 when the whole command is shown. */
  hidden: number;
  toggle: "expand" | "collapse" | null;
};

/** Decide which lines of a command render, and which toggle (if any) follows.
 *
 * The command text is repaired first: a CLI that hands back a JSON-encoded
 * command leaks `\"` for every quote, which turns a heredoc full of Python
 * docstrings into `\"\"\"`. {@link normalizeOverEscapedQuotes} only fires when
 * every quote in the text is escaped, so real code carrying a genuine escape
 * is left alone. */
export function commandDisplay(
  command: string,
  { expanded }: { expanded: boolean },
): CommandDisplay {
  const text = normalizeOverEscapedQuotes(command).replace(/\s+$/, "");
  const lines = text.split("\n");
  if (lines.length <= COMMAND_PREVIEW_LINES) return { lines, hidden: 0, toggle: null };
  if (expanded) return { lines, hidden: 0, toggle: "collapse" };
  return {
    lines: lines.slice(0, COMMAND_PREVIEW_LINES),
    hidden: lines.length - COMMAND_PREVIEW_LINES,
    toggle: "expand",
  };
}

/**
 * The transcript keeps everything the agent did, live and after settle: tool
 * and command lines so long silent stretches read as activity, and reasoning
 * because a run can spend minutes thinking before it writes a word — hiding it
 * left exactly those stretches blank, and a run that crashed before answering
 * rendered nothing at all.
 *
 * `userVisibleAgentSegments` stays prose-only: it decides the raw fallback and
 * drives the copy affordance, neither of which wants reasoning.
 *
 * Lifecycle narration is the one exception to "keep everything": started /
 * finished / changed-files rows only narrate progress, so once the run
 * settles they are dropped — the chrome already reports the outcome. Warn and
 * error narration stays.
 */
// Pure lifecycle narration — "Codex started.", "Claude finished.", "Codex
// changed files." — is progress signal while the run is live, but once the
// turn settles the chrome already shows the run is over and the rows add
// nothing; they would sit in the transcript forever. warn/bad narrations
// (api retries, failures, omitted stderr) report something the chrome does
// not, so they survive settling.
function narrationSurvivesSettle(segment: AgentSegment): boolean {
  if (segment.kind !== "narration") return true;
  const tone = segment.params?.tone;
  return tone === "warn" || tone === "bad";
}

/** Fold runs of adjacent reasoning into one block.
 *
 * How many `thinking` segments a turn produces is an artifact of the CLI's
 * chunking, not of the agent's train of thought: Codex emits one `reasoning`
 * item per summary chunk, so a single deliberation arrived as a dozen segments
 * and rendered as a dozen identical collapsed rows. Only reasoning separated by
 * real work — a tool call, a command, prose — is a new thought worth its own
 * block. Runs of one keep their original object so callers that track a segment
 * by identity (the live stdout tail) still find it.
 */
function mergeAdjacentReasoning(segments: AgentSegment[]): AgentSegment[] {
  const out: AgentSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (segment.kind === "thinking" && previous?.kind === "thinking") {
      out[out.length - 1] = { kind: "thinking", text: `${previous.text}\n\n${segment.text}` };
      continue;
    }
    out.push(segment);
  }
  return out;
}

export function displayAgentSegments(segments: AgentSegment[], streaming: boolean): AgentSegment[] {
  if (streaming) return mergeAdjacentReasoning(segments);
  const visible = new Set(userVisibleAgentSegments(segments));
  // Merge after the filter, so reasoning left adjacent by a dropped lifecycle
  // narration folds together the way the reader sees it.
  return mergeAdjacentReasoning(
    segments.filter(
      (segment) =>
        narrationSurvivesSettle(segment)
        && (segment.kind === "tool"
          || segment.kind === "command"
          || segment.kind === "thinking"
          || visible.has(segment)),
    ),
  );
}

/**
 * Prepare the combined transcript while tracking the active stdout tail
 * independently from stderr rows, which are always rendered afterward.
 */
export function displayAgentStreamSegments(
  stdoutSegments: AgentSegment[],
  stderrSegments: AgentSegment[],
  streaming: boolean,
): { segments: AgentSegment[]; liveTextIndex: number } {
  const segments = displayAgentSegments([...stdoutSegments, ...stderrSegments], streaming);
  if (!streaming) return { segments, liveTextIndex: -1 };
  const visibleStdout = displayAgentSegments(stdoutSegments, true);
  const stdoutTail = visibleStdout[visibleStdout.length - 1];
  if (stdoutTail?.kind !== "text") return { segments, liveTextIndex: -1 };
  return { segments, liveTextIndex: segments.indexOf(stdoutTail) };
}

export function hasStreamingTextCaret(segments: AgentSegment[]): boolean {
  return segments[segments.length - 1]?.kind === "text";
}

// The two end-of-turn narrations that report success. Failure is recognised by
// tone instead, so every agent's error shape is covered without enumerating it.
const TERMINAL_SUCCESS_KEYS: ReadonlySet<string> = new Set([
  "agent_stream.claude_finished",
  "agent_stream.codex_finished",
]);

function segmentTone(segment: AgentSegment): string | undefined {
  if (segment.kind === "status") return segment.tone;
  if (segment.kind === "narration" && typeof segment.params?.tone === "string") return segment.params.tone;
  return undefined;
}

/**
 * True once the agent's own stream has reported the turn is over — Claude's
 * `result`, Codex's `turn.completed`/`turn.failed`, or any agent's error frame.
 *
 * The run stays `streaming` until the daemon posts `agent.completed`, so
 * without this the transcript keeps a "Working…" pulse under a line that
 * already says the agent finished. Only `bad` tones count as terminal: `info`
 * belongs to start/progress narrations and `warn` to retries and stderr
 * chatter, all of which happen mid-run while the agent really is still working.
 */
export function hasTerminalOutcome(segments: AgentSegment[]): boolean {
  return segments.some(
    (segment) =>
      (segment.kind === "narration" && TERMINAL_SUCCESS_KEYS.has(segment.key)) || segmentTone(segment) === "bad",
  );
}

export function agentMessagePlainText(
  agent: AgentName,
  stdout: string,
  stderr: string,
  t: TFunction,
  streaming = false,
): string {
  const segments = displayAgentSegments(
    [...parseAgentStream(agent, stdout), ...parseAgentStderr(stderr)],
    streaming,
  );
  return segments
    .map((segment) => {
      if (segment.kind === "text" || segment.kind === "status" || segment.kind === "raw") return segment.text;
      if (segment.kind === "narration") return t(segment.key, segment.params);
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
