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

type ActivityGroupItem = Extract<ActivityItem, { type: "activity" }>;

function sameEntries(previous: readonly ActivityEntry[], next: readonly ActivityEntry[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before.segment !== after.segment || before.key !== after.key || before.index !== after.index) return false;
  }
  return true;
}

/** The item a run of calls renders as. A group whose entries are the same
 *  segments as last frame's is last frame's group object, so a memoized
 *  component above it sees an unchanged prop. */
function runItems(run: ActivityEntry[], previousByKey: ReadonlyMap<string, ActivityGroupItem>): ActivityItem[] {
  if (run.length < MIN_GROUP_SIZE) return run.map((entry) => ({ type: "segment" as const, ...entry }));
  const key = run[0]!.key;
  const previous = previousByKey.get(key);
  if (previous && sameEntries(previous.entries, run)) return [previous];
  return [{ type: "activity", key, entries: run }];
}

/** Folds consecutive tool/command segments into activity groups. `keys` is the
 *  per-segment identity from `segmentKeys`; a group keys on its first call so
 *  it keeps its open/closed state while later calls append to it. Pass the
 *  previous frame's items to keep each unchanged group's identity: a run
 *  streams a frame at a time, and the groups above the live one never move. */
export function groupActivity(
  segments: AgentSegment[],
  keys: string[],
  previous: readonly ActivityItem[] = [],
): ActivityItem[] {
  const previousByKey = new Map<string, ActivityGroupItem>();
  for (const item of previous) {
    if (item.type === "activity") previousByKey.set(item.key, item);
  }
  const items: ActivityItem[] = [];
  // Built in place: a run of k calls used to copy itself k times. The array
  // is handed over whole and never touched again, so no caller sees it move.
  let run: ActivityEntry[] = [];
  segments.forEach((segment, index) => {
    const entry = { key: keys[index]!, segment, index };
    if (isActivity(segment)) {
      run.push(entry);
      return;
    }
    if (run.length > 0) {
      items.push(...runItems(run, previousByKey));
      run = [];
    }
    items.push({ type: "segment", ...entry });
  });
  if (run.length > 0) items.push(...runItems(run, previousByKey));
  return items;
}

export function activityCounts(segments: AgentSegment[]): { tools: number; commands: number } {
  const commands = segments.filter((segment) => segment.kind === "command").length;
  const tools = segments.filter((segment) => segment.kind === "tool").length;
  return { tools, commands };
}
