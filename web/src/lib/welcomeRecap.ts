import type { RelayTaskListItem } from "../types.js";
import type { ThreadItem } from "./threads.js";
import { groupThreads } from "./threadGroups.ts";
import { isAwaitingHuman } from "./workflow.ts";

/** The new-thread landing as a welcome back: what waits on the person, what
 * is moving, and what landed since yesterday — a glance, never a second
 * thread list, so each kind is capped. Derived from the threads the app has
 * already loaded; nothing is stored. */
export type WelcomeRowKind = "needs_you" | "running" | "finished";

export type WelcomeRow = { kind: WelcomeRowKind; item: ThreadItem };

export type WelcomeRecap = {
  rows: WelcomeRow[];
  /** Every thread waiting on the person, not just the ones shown. */
  needsYouTotal: number;
  /** Threads finished in the last seven days, and the agents that worked them. */
  week: { finished: number; agents: number };
};

export type GreetingPeriod = "late" | "morning" | "afternoon" | "evening";

const DAY_MS = 86_400_000;
const FRESH_WINDOW_MS = DAY_MS;
const WEEK_WINDOW_MS = 7 * DAY_MS;
const ROWS_PER_KIND = 2;

function updatedWithin(item: ThreadItem, windowMs: number, now: number): boolean {
  const at = Date.parse(item.session.updatedAt);
  return Number.isFinite(at) && now - at <= windowMs;
}

function finishedCleanly(item: ThreadItem): boolean {
  return item.session.status === "completed" && !isAwaitingHuman(item.session);
}

function newestFirst(a: ThreadItem, b: ThreadItem): number {
  return Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt);
}

function weekSummary(items: readonly ThreadItem[], now: number): WelcomeRecap["week"] {
  const finished = items.filter((item) => finishedCleanly(item) && updatedWithin(item, WEEK_WINDOW_MS, now));
  const agents = new Set(
    finished.flatMap((item) => (item.session.agentRuns ?? []).map((run) => run.logicalAgentId ?? run.agent)),
  );
  return { finished: finished.length, agents: agents.size };
}

export function buildWelcomeRecap(
  items: readonly ThreadItem[],
  tasks: readonly RelayTaskListItem[],
  now: number,
): WelcomeRecap {
  const groups = groupThreads(items, tasks);
  const needsYou = [...groups.needsYou].sort(newestFirst);
  const running = [...groups.running].sort(newestFirst);
  const finished = groups.idle
    .filter((item) => finishedCleanly(item) && updatedWithin(item, FRESH_WINDOW_MS, now))
    .sort(newestFirst);
  const rows: WelcomeRow[] = [
    ...needsYou.slice(0, ROWS_PER_KIND).map((item) => ({ kind: "needs_you" as const, item })),
    ...running.slice(0, ROWS_PER_KIND).map((item) => ({ kind: "running" as const, item })),
    ...finished.slice(0, ROWS_PER_KIND).map((item) => ({ kind: "finished" as const, item })),
  ];
  return { rows, needsYouTotal: needsYou.length, week: weekSummary(items, now) };
}

export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour < 5) return "late";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** First word of the display name, else the username — "Fei", not "Fei He". */
export function greetingName(user: { displayName?: string; username: string }): string {
  const first = user.displayName?.trim().split(/\s+/)[0];
  return first || user.username.trim();
}
