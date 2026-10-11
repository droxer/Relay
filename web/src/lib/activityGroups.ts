import type { AgentSegment } from "./agentStream.ts";

/** One segment as it renders, with its stream index so callers can still ask
 *  "is this the live text?" against `liveTextIndex`. */
export type ActivityEntry = { key: string; segment: AgentSegment; index: number };

/**
 * A rendered transcript item: a segment on its own, or a run of consecutive
 * tool/command calls folded into one activity group — the shape Claude and
 * Codex both settled on, where "Used 3 tools, ran 2 commands" stands in for
 * the log until the reader asks for it.
 */
export type ActivityItem =
  | ({ type: "segment" } & ActivityEntry)
  | { type: "activity"; key: string; entries: ActivityEntry[] };

/** A group needs at least this many calls; one tool line folds to nothing. */
const MIN_GROUP_SIZE = 2;

function isActivity(segment: AgentSegment): boolean {
  return segment.kind === "tool" || segment.kind === "command";
}

function runItems(run: ActivityEntry[]): ActivityItem[] {
  if (run.length >= MIN_GROUP_SIZE) return [{ type: "activity", key: run[0]!.key, entries: run }];
  return run.map((entry) => ({ type: "segment" as const, ...entry }));
}

/** Folds consecutive tool/command segments into activity groups. `keys` is the
 *  per-segment identity from `segmentKeys`; a group keys on its first call so
 *  it keeps its open/closed state while later calls append to it. */
export function groupActivity(segments: AgentSegment[], keys: string[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let run: ActivityEntry[] = [];
  segments.forEach((segment, index) => {
    const entry = { key: keys[index]!, segment, index };
    if (isActivity(segment)) {
      run = [...run, entry];
      return;
    }
    items.push(...runItems(run), { type: "segment", ...entry });
    run = [];
  });
  items.push(...runItems(run));
  return items;
}

export function activityCounts(segments: AgentSegment[]): { tools: number; commands: number } {
  const commands = segments.filter((segment) => segment.kind === "command").length;
  const tools = segments.filter((segment) => segment.kind === "tool").length;
  return { tools, commands };
}
