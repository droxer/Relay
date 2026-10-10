/* An automation run's opening message, read back into parts so the thread can
   draw it as a card instead of the raw prompt text.

   The backend writes the occurrence's goal as `title\n\ndescription`
   (scheduler.py `task_goal_text`) and, for a run something fired, appends
   `trigger_context_block` (automations/trigger.py) to the description. That
   block stays English on purpose — it is the agent's prompt — so the web
   parses its fixed shapes here and translates them on render. Keep the
   patterns in step with `_event_line`; anything unrecognised passes through
   as text rather than being dropped. */

import type { RoutineTriggerKind } from "../types.js";
import { runTriggerLabel } from "./automationTrigger.ts";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type OpeningEvent =
  | { kind: "manual" }
  | { kind: "status_changed"; taskId: string; title: string; from: string; to: string }
  | { kind: "task_created"; taskId: string; title: string }
  | { kind: "run"; outcome: "completed" | "failed"; taskId?: string; title?: string; sessionId?: string; error?: string }
  | { kind: "webhook"; payload: string }
  | { kind: "other"; text: string };

export type OpeningTrigger = {
  /** The event type that fired the run (`manual`, `task.created`, …), or null
      when the label is one this build does not know. */
  eventType: string | null;
  eventCount: number;
  /** Events coalesced into the run but not listed in the block. */
  dropped: number;
  /** The first listed status change's target, for "Issue status → Done". */
  toStatus?: string;
  events: OpeningEvent[];
};

export type AutomationOpening = {
  title: string;
  body: string;
  /** Null for a scheduled run, which carries no trigger block. */
  trigger: OpeningTrigger | null;
};

const BLOCK_MARKER = "---\nTrigger context\n";
const FIRED_BY_PREFIX = "Fired by: ";
const EVENT_PREFIX = "- ";

/** trigger.py `EVENT_LABELS`, inverted. */
const EVENT_TYPES_BY_LABEL: Readonly<Record<string, string>> = {
  "Task created": "task.created",
  "Task status changed": "task.status_changed",
  "Run completed": "run.completed",
  "Run failed": "run.failed",
  Webhook: "webhook",
  Manual: "manual",
};

const TASK = String.raw`Task (\S+) "(.*)"`;
const STATUS_CHANGED = new RegExp(String.raw`^${TASK} — (\S+) → (\S+)$`);
const TASK_CREATED = new RegExp(String.raw`^${TASK} — created$`);
const RUN = new RegExp(String.raw`^(?:${TASK}|Thread (\S+)) — run (completed|failed)(?:: ([\s\S]*))?$`);
const WEBHOOK = /^Webhook payload \(JSON\):\n([\s\S]*)$/;
const FIRED_BY = /^(.*?)(?: \((\d+) events?(?:, (\d+) not listed)?\))?$/;

/**
 * The opening's parts, or null when `text` carries no trigger block and the
 * caller has not said the thread is a scheduled automation run.
 */
export function parseAutomationOpening(
  text: string,
  options: { scheduled?: boolean } = {},
): AutomationOpening | null {
  const at = blockStart(text);
  if (at < 0) return options.scheduled ? { ...splitGoal(text), trigger: null } : null;
  return {
    ...splitGoal(text.slice(0, at)),
    trigger: parseBlock(text.slice(at + BLOCK_MARKER.length)),
  };
}

function blockStart(text: string): number {
  if (text.startsWith(BLOCK_MARKER)) return 0;
  const at = text.lastIndexOf(`\n${BLOCK_MARKER}`);
  return at < 0 ? -1 : at + 1;
}

function splitGoal(goal: string): { title: string; body: string } {
  const trimmed = goal.trim();
  const gap = trimmed.indexOf("\n\n");
  return gap < 0
    ? { title: trimmed, body: "" }
    : { title: trimmed.slice(0, gap).trim(), body: trimmed.slice(gap + 2).trim() };
}

function parseBlock(block: string): OpeningTrigger {
  const [firstLine = "", ...rest] = block.split("\n");
  const firedBy = firstLine.startsWith(FIRED_BY_PREFIX) ? firstLine.slice(FIRED_BY_PREFIX.length) : firstLine;
  const [, label = "", count, dropped] = FIRED_BY.exec(firedBy) ?? [];
  const events = eventTexts(rest).map((text) => parseEvent(text.trimEnd()));
  const toStatus = events.find((event) => event.kind === "status_changed")?.to;
  return {
    eventType: EVENT_TYPES_BY_LABEL[label] ?? null,
    eventCount: count ? Number(count) : 1,
    dropped: dropped ? Number(dropped) : 0,
    ...(toStatus ? { toStatus } : {}),
    events,
  };
}

/** One entry per `- ` line; a line without the prefix continues the one above
    (a webhook payload, a multi-line run error). */
function eventTexts(lines: readonly string[]): string[] {
  const texts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(EVENT_PREFIX)) texts.push(line.slice(EVENT_PREFIX.length));
    else if (texts.length > 0) texts[texts.length - 1] += `\n${line}`;
  }
  return texts;
}

function parseEvent(text: string): OpeningEvent {
  if (text === "Run now requested.") return { kind: "manual" };
  const status = STATUS_CHANGED.exec(text);
  if (status) return { kind: "status_changed", taskId: status[1], title: status[2], from: status[3], to: status[4] };
  const created = TASK_CREATED.exec(text);
  if (created) return { kind: "task_created", taskId: created[1], title: created[2] };
  const run = RUN.exec(text);
  if (run) {
    const [, taskId, title, sessionId, outcome, error] = run;
    return {
      kind: "run",
      outcome: outcome as "completed" | "failed",
      ...(taskId ? { taskId, title } : { sessionId }),
      ...(error ? { error } : {}),
    };
  }
  const webhook = WEBHOOK.exec(text);
  if (webhook) return { kind: "webhook", payload: webhook[1] };
  return { kind: "other", text };
}

const TRIGGER_KINDS_BY_EVENT: Readonly<Record<string, RoutineTriggerKind>> = {
  "task.created": "task_event",
  "task.status_changed": "task_event",
  "run.completed": "run_event",
  "run.failed": "run_event",
  webhook: "webhook",
  manual: "manual",
};

/** What started the run, in the run ledger's words: "Manual", "Scheduled",
    "Issue status → Done · 3 events". */
export function openingTriggerLabel(trigger: OpeningTrigger | null, t: Translate): string {
  if (!trigger) return t("automation.ledger.schedule");
  const triggerKind = trigger.eventType ? TRIGGER_KINDS_BY_EVENT[trigger.eventType] : undefined;
  if (!triggerKind || !trigger.eventType) return t("automation.opening.triggered");
  return runTriggerLabel({
    triggerKind,
    triggerSummary: {
      eventType: trigger.eventType,
      eventCount: trigger.eventCount,
      ...(trigger.toStatus ? { toStatus: trigger.toStatus as never } : {}),
    },
  }, t) ?? t("automation.opening.triggered");
}

/** The events worth listing under the card. A Run now's only event restates
    the "Manual" label, so a manual run lists nothing. */
export function listedOpeningEvents(trigger: OpeningTrigger | null): OpeningEvent[] {
  return trigger ? trigger.events.filter((event) => event.kind !== "manual") : [];
}
