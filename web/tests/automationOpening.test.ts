import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listedOpeningEvents, openingTriggerLabel, parseAutomationOpening } from "../src/lib/automationOpening.js";

// Fixtures mirror backend/relay/automations/trigger.py `trigger_context_block`
// appended to a routine occurrence's description (`routine_occurrence_events`)
// and joined to its title by `task_goal_text`.
const goal = (description: string, block?: string) =>
  ["每周 AI 动态", [description, block].filter(Boolean).join("\n\n")].filter(Boolean).join("\n\n");

describe("parseAutomationOpening", () => {
  it("preserves bulleted multiline errors inside their run event", () => {
    const block = [
      "---", "Trigger context", "Fired by: Run failed (2 events)",
      "- Thread ses_1 — run failed: command failed",
      "- missing dependency", "- permission denied",
      "- Thread ses_2 — run completed",
    ].join("\n");
    assert.deepEqual(parseAutomationOpening(goal("Brief", block))?.trigger?.events, [
      { kind: "run", outcome: "failed", sessionId: "ses_1", error: "command failed\n- missing dependency\n- permission denied" },
      { kind: "run", outcome: "completed", sessionId: "ses_2" },
    ]);
  });

  it("splits a manual Run now into title, brief, and its trigger", () => {
    const opening = parseAutomationOpening(goal("每周抓取 AI 动态", "---\nTrigger context\nFired by: Manual\n- Run now requested."));
    assert.deepEqual(opening, {
      title: "每周 AI 动态",
      body: "每周抓取 AI 动态",
      trigger: { eventType: "manual", eventCount: 1, dropped: 0, events: [{ kind: "manual" }] },
    });
  });

  it("reads coalesced task events, their count, and the ones left unlisted", () => {
    const block = [
      "---",
      "Trigger context",
      "Fired by: Task status changed (4 events, 1 not listed)",
      '- Task t_1 "Ship the "beta" docs" — backlog → done',
      '- Task t_2 "Triage" — created',
      '- Task t_3 "Deploy" — run failed: exit 1',
    ].join("\n");
    const opening = parseAutomationOpening(goal("", block));
    assert.equal(opening?.title, "每周 AI 动态");
    assert.equal(opening?.body, "");
    assert.deepEqual(opening?.trigger, {
      eventType: "task.status_changed",
      eventCount: 4,
      dropped: 1,
      toStatus: "done",
      events: [
        { kind: "status_changed", taskId: "t_1", title: 'Ship the "beta" docs', from: "backlog", to: "done" },
        { kind: "task_created", taskId: "t_2", title: "Triage" },
        { kind: "run", outcome: "failed", taskId: "t_3", title: "Deploy", error: "exit 1" },
      ],
    });
  });

  it("keeps a thread run and a multi-line webhook payload intact", () => {
    const block = [
      "---",
      "Trigger context",
      "Fired by: Webhook (2 events)",
      "- Thread ses_9 — run completed",
      "- Webhook payload (JSON):",
      '{"a": 1}',
    ].join("\n");
    assert.deepEqual(parseAutomationOpening(goal("Brief", block))?.trigger?.events, [
      { kind: "run", outcome: "completed", sessionId: "ses_9" },
      { kind: "webhook", payload: '{"a": 1}' },
    ]);
  });

  it("passes an unrecognised event line through as text", () => {
    const block = "---\nTrigger context\nFired by: Something new\n- A shape this build does not know";
    const trigger = parseAutomationOpening(goal("", block))?.trigger;
    assert.equal(trigger?.eventType, null);
    assert.deepEqual(trigger?.events, [{ kind: "other", text: "A shape this build does not know" }]);
  });

  it("is null for a message with no trigger block", () => {
    assert.equal(parseAutomationOpening("Fix the login bug\n\n---\nNotes below"), null);
  });

  it("splits a scheduled run's goal when asked to, with no trigger", () => {
    assert.deepEqual(parseAutomationOpening("Weekly digest\n\nCollect the news.", { scheduled: true }), {
      title: "Weekly digest",
      body: "Collect the news.",
      trigger: null,
    });
  });
});

describe("openingTriggerLabel", () => {
  const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key);
  const trigger = (eventType: string | null, extra: object = {}) =>
    ({ eventType, eventCount: 1, dropped: 0, events: [], ...extra });

  it("speaks the run ledger's words for each start", () => {
    assert.equal(openingTriggerLabel(null, t), "automation.ledger.schedule");
    assert.equal(openingTriggerLabel(trigger("manual"), t), "automation.ledger.manual");
    assert.equal(openingTriggerLabel(trigger("webhook"), t), "automation.ledger.webhook");
    assert.equal(
      openingTriggerLabel(trigger("task.status_changed", { toStatus: "done", eventCount: 3 }), t),
      'automation.ledger.status_changed{"status":"backlog.statuses.done"} · automation.ledger.event_count{"count":3}',
    );
  });

  it("falls back to a neutral word for a label this build does not know", () => {
    assert.equal(openingTriggerLabel(trigger(null), t), "automation.opening.triggered");
  });
});

describe("listedOpeningEvents", () => {
  it("drops the Run now line the Manual label already says", () => {
    const events = [{ kind: "manual" as const }, { kind: "other" as const, text: "x" }];
    assert.deepEqual(listedOpeningEvents({ eventType: "manual", eventCount: 2, dropped: 0, events }), [events[1]]);
    assert.deepEqual(listedOpeningEvents(null), []);
  });
});
