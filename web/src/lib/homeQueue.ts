/**
 * Home's "Up next" queue: everything that wants the signed-in person, ranked.
 *
 * Derived from what the app already loads — tasks, threads, computers — so
 * there is nothing to store but snoozes. The tiers say how much work an item
 * holds up:
 *
 *   paused       a live run asked permission and holds its computer meanwhile
 *   needs_you    a task parked on its person: a wait (question, check, budget,
 *                approval) or finished work in review — Tasks' `needs_me`
 *   stuck        blocked work, or work that cannot start on a dark computer
 *   worth_doing  overdue work, intake with no project, an agent's suggestion
 *
 * Inside a tier the oldest item comes first. A task appears once, at its most
 * urgent reason. A snooze hides an item until its stamp changes, so anything
 * that happens to it brings it back.
 */
import type { PermissionRequest, TaskAwaiting } from "relay-core";
import type { DaemonNodeMonitorRecord, RelaySession, RelayTaskListItem } from "../types.js";
import { dueTone } from "./backlog.ts";
import { issueNeedsProject } from "./issueQueues.ts";
import { threadNextSteps } from "./nextSteps.ts";
import { openPermissionRequests } from "./permissionRequests.ts";

export const HOME_TIERS = ["paused", "needs_you", "stuck", "worth_doing"] as const;
export type HomeTier = (typeof HOME_TIERS)[number];

/** Suggestions are the softest item; more than a few would bury the rest. */
const SUGGESTION_LIMIT = 3;

interface HomeItemBase {
  /** Stable identity across renders and snoozes. */
  key: string;
  /** The item's current state; a snooze holds only while this is unchanged. */
  stamp: string;
  tier: HomeTier;
  /** When the item started wanting the person — the sort key within a tier. */
  since: string;
  projectId?: string;
}

export type HomeItem =
  | HomeItemBase & { kind: "permission"; session: RelaySession; request: PermissionRequest }
  | HomeItemBase & { kind: "wait"; task: RelayTaskListItem; awaiting: TaskAwaiting }
  | HomeItemBase & { kind: "review" | "blocked" | "overdue"; task: RelayTaskListItem }
  | HomeItemBase & { kind: "offline"; node: DaemonNodeMonitorRecord; waitingToStart: number }
  | HomeItemBase & { kind: "untriaged"; tasks: RelayTaskListItem[] }
  | HomeItemBase & { kind: "suggested"; session: RelaySession; step: string };

export type HomeItemKind = HomeItem["kind"];

export interface HomeSnooze {
  key: string;
  stamp: string;
}

export interface HomeQueueInput {
  tasks: readonly RelayTaskListItem[];
  sessions: readonly RelaySession[];
  nodes: readonly DaemonNodeMonitorRecord[];
  userId: string;
  /** Local calendar day, `YYYY-MM-DD` — what "overdue" is measured against. */
  today: string;
  snoozes?: readonly HomeSnooze[];
}

export function homeQueue(input: HomeQueueInput): HomeItem[] {
  const mine = input.tasks.filter((task) => isLiveIssue(task) && responsibleUser(task) === input.userId);
  const items = [
    ...permissionItems(input.sessions, input.userId),
    ...taskItems(mine, input.today),
    ...offlineItems(input.nodes, mine, input.userId),
    ...untriagedItems(mine),
    ...suggestionItems(input.sessions, input.userId),
  ];
  const snoozed = new Map((input.snoozes ?? []).map((snooze) => [snooze.key, snooze.stamp]));
  return items
    .filter((item) => snoozed.get(item.key) !== item.stamp)
    .sort(byTierThenAge);
}

/** What the rail badge counts: only the tiers that hold someone's work up. */
export function homeNeedsYouCount(items: readonly HomeItem[]): number {
  return items.filter((item) => item.tier === "paused" || item.tier === "needs_you").length;
}

function isLiveIssue(task: RelayTaskListItem): boolean {
  return !task.isRoutine && !task.deletedAt && task.status !== "done";
}

/** Mirrors `responsibleUser` in issueQueues: the assignee, else the owner. */
function responsibleUser(task: RelayTaskListItem): string | undefined {
  return task.assigneeUserId ?? task.ownerUserId;
}

function ownedBy(session: RelaySession, userId: string): boolean {
  if (session.archived || session.deletionRequestedAt) return false;
  return !session.ownerUserId || session.ownerUserId === userId;
}

function permissionItems(sessions: readonly RelaySession[], userId: string): HomeItem[] {
  return sessions
    .filter((session) => ownedBy(session, userId))
    .flatMap((session) => openPermissionRequests(session).map((request): HomeItem => ({
      kind: "permission",
      key: `permission:${session.id}:${request.id}`,
      stamp: request.id,
      tier: "paused",
      since: request.requestedAt,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      session,
      request,
    })));
}

function taskItems(tasks: readonly RelayTaskListItem[], today: string): HomeItem[] {
  return tasks.flatMap((task): HomeItem[] => {
    const base = {
      key: `task:${task.id}`,
      stamp: task.updatedAt,
      since: task.updatedAt,
      ...(task.projectId ? { projectId: task.projectId } : {}),
    };
    const { awaiting } = task;
    if (task.status === "waiting_for_human" && awaiting) {
      // A routine template's wait is shown on its own page, never resumed by a reply.
      return awaiting.resumable ? [{ ...base, kind: "wait", tier: "needs_you", task, awaiting }] : [];
    }
    if (task.status === "review") return [{ ...base, kind: "review", tier: "needs_you", task }];
    if (task.status === "blocked") return [{ ...base, kind: "blocked", tier: "stuck", task }];
    if (dueTone(task, today) === "bad") {
      return [{ ...base, kind: "overdue", tier: "worth_doing", since: task.dueDate ?? task.updatedAt, task }];
    }
    return [];
  });
}

/** A computer of yours that is dark while your work waits to start. Which
 *  computer a queued task will land on is decided at dispatch, so this says
 *  only that work is waiting — not that it waits on this computer. */
function offlineItems(
  nodes: readonly DaemonNodeMonitorRecord[],
  mine: readonly RelayTaskListItem[],
  userId: string,
): HomeItem[] {
  const waitingToStart = mine.filter((task) => task.status === "assigned").length;
  if (!waitingToStart) return [];
  return nodes
    .filter((node) => node.userId === userId && !node.retiredAt && (!node.online || node.stale))
    .map((node): HomeItem => {
      const seen = node.lastSeenAt ?? node.updatedAt;
      return { kind: "offline", key: `node:${node.id}`, stamp: seen, tier: "stuck", since: seen, node, waitingToStart };
    });
}

function untriagedItems(mine: readonly RelayTaskListItem[]): HomeItem[] {
  const intake = mine.filter(issueNeedsProject);
  if (!intake.length) return [];
  const created = intake.map((task) => task.createdAt).sort();
  return [{
    kind: "untriaged",
    key: "untriaged",
    // New intake brings a snoozed pile back; triaging some of it does not.
    stamp: created.at(-1)!,
    tier: "worth_doing",
    since: created[0],
    tasks: intake,
  }];
}

function suggestionItems(sessions: readonly RelaySession[], userId: string): HomeItem[] {
  return sessions
    .filter((session) => ownedBy(session, userId))
    .flatMap((session): HomeItem[] => {
      const [step] = threadNextSteps(session, { busy: false });
      if (!step) return [];
      return [{
        kind: "suggested",
        key: `suggested:${session.id}`,
        stamp: session.updatedAt,
        tier: "worth_doing",
        since: session.updatedAt,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        session,
        step,
      }];
    })
    .sort((left, right) => right.since.localeCompare(left.since))
    .slice(0, SUGGESTION_LIMIT);
}

function byTierThenAge(left: HomeItem, right: HomeItem): number {
  const tier = HOME_TIERS.indexOf(left.tier) - HOME_TIERS.indexOf(right.tier);
  return tier || left.since.localeCompare(right.since) || left.key.localeCompare(right.key);
}
