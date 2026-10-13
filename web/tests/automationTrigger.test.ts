import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  describeTrigger, describeTriggers, normalizeTriggerForSave, runTriggerLabel, triggerError, triggerForKind, triggersEqual, triggersOf,
} from "../src/lib/automationTrigger.ts";
import { SCHEDULE_PRESETS, repeatForPreset } from "../src/lib/automationSchedule.ts";
import { routineState } from "../src/lib/routine.ts";
import type { RelayTaskListItem, TaskRun } from "../src/types.ts";

describe("automation triggers", () => {
  it("reads missing triggers as none and drops unknown kinds", () => {
    assert.deepEqual(triggersOf({}), []);
    assert.deepEqual(triggersOf({ routineTriggers: [{ kind: "bogus" } as never, { kind: "webhook" }] }), [{ kind: "webhook" }]);
  });

  it("gives event kinds a default `on` and a schedule a default schedule", () => {
    assert.deepEqual(triggerForKind("task_event"), { kind: "task_event", on: "status_changed" });
    assert.deepEqual(triggerForKind("run_event"), { kind: "run_event", on: "failed" });
    assert.deepEqual(triggerForKind("webhook"), { kind: "webhook" });
    const schedule = triggerForKind("schedule");
    assert.equal(schedule.kind, "schedule");
    assert.deepEqual(schedule.kind === "schedule" && schedule.schedule.repeat, { every: "weekday", at: "09:00" });
  });

  it("describes trigger lists", () => {
    const t = (key: string, options?: Record<string, unknown>) => (options?.count ? `${key}:${options.count}` : key);
    assert.equal(describeTriggers([], t), "automation.run_now_only");
    assert.equal(describeTriggers([{ kind: "webhook" }, { kind: "webhook" }], t), "automation.trigger_count:2");
    assert.equal(describeTriggers([{ kind: "schedule", schedule: { timezone: null, repeat: { every: "day", at: "09:00" } } }], t), "automation.presets.day");
  });

  it("keeps a schedule unchanged on save", () => {
    const trigger = { kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "day", at: "09:00" } } } as const;
    assert.deepEqual(normalizeTriggerForSave(trigger), trigger);
  });

  it("flags a bad schedule through triggerError", () => {
    assert.equal(triggerError({ kind: "schedule", schedule: { timezone: null, repeat: { every: "day", at: "9am" } } }), "automation.errors.time");
  });

  it("drops empty filters and status filters that do not apply", () => {
    assert.deepEqual(normalizeTriggerForSave({
      kind: "task_event", on: "created",
      filters: { projectId: "", toStatus: "blocked", titleContains: "  nightly " },
    }), { kind: "task_event", on: "created", filters: { titleContains: "nightly" } });
    assert.deepEqual(normalizeTriggerForSave({ kind: "webhook", filters: { projectId: "p" } } as never), { kind: "webhook" });
  });

  it("compares triggers by their saved shape", () => {
    assert.ok(triggersEqual([{ kind: "task_event", on: "created", filters: { projectId: "" } }], [{ kind: "task_event", on: "created" }]));
    assert.ok(!triggersEqual([{ kind: "webhook" }], []));
  });

  it("flags an over-long title filter", () => {
    assert.equal(triggerError({ kind: "task_event", on: "created", filters: { titleContains: "x".repeat(121) } }),
      "automation.errors.title_too_long");
    assert.equal(triggerError({ kind: "webhook" }), null);
  });

  it("shows active event automations as listening", () => {
    const base = { id: "R-1", isRoutine: true, routineState: "active" } as RelayTaskListItem;
    assert.equal(routineState({ ...base, routineTriggers: [{ kind: "webhook" }] }, new Set()), "listening");
    assert.equal(routineState({ ...base, routineState: "paused", routineTriggers: [{ kind: "webhook" }] }, new Set()), "paused");
  });
});

it("compares filters independent of insertion order", () => {
  assert.ok(triggersEqual(
    [{ kind: "task_event", on: "created", filters: { priority: "high", projectId: "p" } }],
    [{ kind: "task_event", on: "created", filters: { projectId: "p", priority: "high" } }],
  ));
});

describe("automation trigger labels", () => {
  /* A strict `t` over the real locale files: a missing key throws instead of
     rendering its own name, which is how the ledger leaked raw keys. */
  function strictT(locale: string) {
    const tree = JSON.parse(readFileSync(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8"));
    const lookup = (key: string) => key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
    return (key: string, options?: Record<string, unknown>): string => {
      const plural = options && "count" in options ? lookup(`${key}_other`) : undefined;
      const value = lookup(key) ?? plural;
      if (typeof value !== "string") throw new Error(`${locale} is missing ${key}`);
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ""));
    };
  }

  const RUNS: TaskRun["triggerSummary"][] = [
    { eventType: "task.created", eventCount: 1 },
    { eventType: "task.status_changed", toStatus: "blocked", eventCount: 3 },
    { eventType: "run.completed", eventCount: 2 },
    { eventType: "run.failed", eventCount: 1 },
    { eventType: "webhook", eventCount: 1 },
    { eventType: "manual", eventCount: 1 },
    { eventType: "schedule", eventCount: 1 },
  ];

  for (const locale of ["en", "zh-CN"]) {
    it(`labels every fired run in ${locale}`, () => {
      const t = strictT(locale);
      for (const summary of RUNS) assert.ok(runTriggerLabel({ triggerKind: "task_event", triggerSummary: summary }, t));
      assert.equal(runTriggerLabel({ triggerKind: null, triggerSummary: null }, t), null);
    });

    it(`describes every trigger in ${locale}`, () => {
      const t = strictT(locale);
      for (const preset of SCHEDULE_PRESETS) {
        assert.ok(describeTrigger({ kind: "schedule", schedule: { timezone: null, repeat: repeatForPreset(preset) } }, t));
      }
      assert.ok(describeTrigger({ kind: "webhook" }, t));
      assert.ok(describeTriggers([], t));
      assert.ok(describeTriggers([{ kind: "webhook" }, { kind: "webhook" }], t));
      assert.ok(runTriggerLabel({ triggerKind: "schedule", triggerSummary: null }, t));
      for (const on of ["created", "status_changed"] as const) assert.ok(describeTrigger({ kind: "task_event", on }, t));
      for (const on of ["completed", "failed"] as const) assert.ok(describeTrigger({ kind: "run_event", on }, t));
    });
  }

  it("names the target status and the event count", () => {
    const t = strictT("en");
    assert.equal(runTriggerLabel({ triggerKind: "task_event", triggerSummary: RUNS[1] }, t), "Task status → Blocked · 3 events");
    assert.equal(runTriggerLabel({ triggerKind: "run_event", triggerSummary: RUNS[3] }, t), "Run failed");
    assert.equal(describeTrigger({ kind: "task_event", on: "status_changed", filters: { toStatus: "blocked" } }, t), "Task status → Blocked");
    assert.equal(describeTrigger({ kind: "task_event", on: "status_changed" }, t), "Task status changed");
  });

  it("gives a Run-now-only automation its own state", () => {
    const manual = { id: "R-1", routineState: "active", routineTriggers: [] } as unknown as RelayTaskListItem;
    const webhook = { id: "R-2", routineState: "active", routineTriggers: [{ kind: "webhook" }] } as unknown as RelayTaskListItem;
    assert.equal(routineState(manual, new Set()), "on_demand");
    assert.equal(routineState(webhook, new Set()), "listening");
  });
});
