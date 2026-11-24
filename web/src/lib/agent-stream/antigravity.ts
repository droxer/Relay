import { asRecord } from "./builders.ts";
import { safeParse } from "./records.ts";

// An omission marker emitted by the daemon's BoundedAgentTranscript.
const OMITTED_OUTPUT = "[... output omitted ...]";

function outputLines(stdout: string): string[] {
  return stdout.split(/(?<=\n)/).filter(Boolean);
}

/** Match occurrences in order, consuming each one once even when deltas repeat. */
function matchLines(source: string[], recovery: string[]): number[] {
  const positions = new Map<string, number[]>();
  for (const [index, line] of source.entries()) {
    const key = line.trimEnd();
    const list = positions.get(key);
    if (list) list.push(index);
    else positions.set(key, [index]);
  }
  const nextPositions = new Map<string, number>();
  let cursor = 0;
  return recovery.map((line) => {
    const key = line.trimEnd();
    const list = positions.get(key);
    if (!list) return -1;
    let next = nextPositions.get(key) ?? 0;
    while (next < list.length && list[next] < cursor) next++;
    nextPositions.set(key, next);
    if (next === list.length) return -1;
    cursor = list[next] + 1;
    return list[next];
  });
}

/** Recover Antigravity's JSONL frames and carry the live steering boundaries
 * through any insertions. A capped log's two retained ends can overlap a
 * stream that already has the missing middle. */
export function recoverAntigravityStdout(
  streamed: string, fallback: string, offsets: readonly number[],
): { stdout: string; offsets: readonly number[] } {
  if (!fallback.trim() || streamed.includes(fallback.trimEnd())) return { stdout: streamed, offsets };
  const at = fallback.indexOf(streamed);
  if (at >= 0) {
    return { stdout: fallback, offsets: offsets.map((offset) => offset ? offset + at : 0) };
  }

  const source = outputLines(streamed);
  const recovery = outputLines(fallback);
  const omission = recovery.findIndex((line) => line.trim() === OMITTED_OUTPUT);
  const head = omission < 0 ? recovery : recovery.slice(0, omission);
  const matches = matchLines(source, head);
  if (omission >= 0) {
    let lastMatch = matches.length - 1;
    while (lastMatch >= 0 && matches[lastMatch] < 0) lastMatch--;
    const headEnd = matches[lastMatch] ?? -1;
    const tail = recovery.slice(omission + 1);
    // Anchor the retained tail from the end so identical deltas in the
    // missing middle do not consume occurrences from the end of the reply.
    const tailMatches = matchLines(source.slice(headEnd + 1).reverse(), tail.reverse())
      .reverse().map((index) => index < 0 ? -1 : source.length - index - 1);
    if ([...matches, ...tailMatches].every((index) => index >= 0)) return { stdout: streamed, offsets };
    matches.push(-1, ...tailMatches);
  } else if (matches.every((index) => index >= 0)) {
    return { stdout: streamed, offsets };
  }

  let stdout = "";
  const mapped: number[] = [];
  let cursor = 0;
  let read = 0;
  const recordOffsets = () => {
    while (mapped.length < offsets.length && offsets[mapped.length] <= read) mapped.push(stdout.length);
  };
  const appendStreamed = (end: number) => {
    while (cursor < end) {
      const line = source[cursor++];
      // The next delivery may finish this frame. It cannot be followed by
      // recovered JSONL until then, since the parser would see a broken object.
      if (line.endsWith("\n") || !line.trimStart().startsWith("{") || safeParse(line)) stdout += line;
      read += line.length;
      recordOffsets();
    }
  };
  const appendRecovered = (line: string) => {
    if (stdout && !stdout.endsWith("\n")) stdout += "\n";
    stdout += line;
  };

  recordOffsets();
  let pending: string[] = [];
  for (let i = 0; i < recovery.length; i++) {
    const match = matches[i];
    if (match < 0) {
      pending.push(recovery[i]);
      continue;
    }
    for (const line of pending) appendRecovered(line);
    pending = [];
    appendStreamed(match + 1);
  }
  appendStreamed(source.length);
  for (const line of pending) appendRecovered(line);
  return { stdout, offsets: mapped };
}

type ToolRouting = {
  source: string;
  offsets: readonly number[];
  tools: Map<string, number>;
  committed: readonly string[];
};

function toolCallId(line: string): string | undefined {
  if (!line.includes('"tool_use"')) return undefined;
  const event = safeParse(line);
  if (event?.type !== "tool_use") return undefined;
  const part = asRecord(event.part);
  const id = part.callID ?? part.id;
  return typeof id === "string" ? id : undefined;
}

/** Keep a call's updates with its first block, while other stdout follows the
 * steering boundaries. The cache commits complete lines so partial deliveries
 * can be redrawn without rescanning the completed transcript. */
export function routeAntigravityToolUpdates(
  source: string, offsets: readonly number[], previous?: ToolRouting,
): { routing: ToolRouting; stdoutByBlock: string[] } {
  const reuse = previous && source.startsWith(previous.source)
    && previous.offsets.every((offset, index) => offsets[index] === offset);
  let cursor = reuse ? previous.source.length : 0;
  const committed = reuse ? [...previous.committed] : [];
  let tools = reuse ? previous.tools : new Map<string, number>();
  let block = offsets.length - 1;
  while (block > 0 && cursor < offsets[block]) block--;
  let nextLine = source.indexOf("\n", cursor);
  while (nextLine >= 0) {
    while (block + 1 < offsets.length && cursor >= offsets[block + 1]) block++;
    const line = source.slice(cursor, nextLine + 1);
    const id = toolCallId(line);
    if (id && !tools.has(id)) {
      if (tools === previous?.tools) tools = new Map(tools);
      tools.set(id, block);
    }
    const destination = id ? tools.get(id) ?? block : block;
    committed[destination] = (committed[destination] ?? "") + line;
    cursor = nextLine + 1;
    nextLine = source.indexOf("\n", cursor);
  }
  const stdoutByBlock = offsets.map((_, index) => committed[index] ?? "");
  const tail = source.slice(cursor);
  const id = toolCallId(tail);
  const destination = (id ? tools.get(id) : undefined) ?? offsets.length - 1;
  stdoutByBlock[destination] += tail;
  return { routing: { source: source.slice(0, cursor), offsets, tools, committed }, stdoutByBlock };
}
