import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTriggerForSave, triggerError, triggerForKind, triggerOf, triggersEqual,
} from "../src/lib/automationTrigger.ts";
import { routineState } from "../src/lib/routine.ts";
import type { RelayTaskListItem } from "../src/types.ts";

describe("automation triggers", () => {
  it("reads a missing or unknown trigger as a schedule", () => {
    assert.deepEqual(triggerOf({}), { kind: "schedule" });
    assert.deepEqual(triggerOf({ routineTrigger: { kind: "bogus" as never } }), { kind: "schedule" });
  });

  it("gives event kinds a default `on` and others none", () => {
    assert.deepEqual(triggerForKind("task_event"), { kind: "task_event", on: "status_changed" });
    assert.deepEqual(triggerForKind("run_event"), { kind: "run_event", on: "failed" });
    assert.deepEqual(triggerForKind("webhook"), { kind: "webhook" });
  });

  it("drops empty filters and status filters that do not apply", () => {
    assert.deepEqual(normalizeTriggerForSave({
      kind: "task_event", on: "created",
      filters: { projectId: "", toStatus: "blocked", titleContains: "  nightly " },
    }), { kind: "task_event", on: "created", filters: { titleContains: "nightly" } });
    assert.deepEqual(normalizeTriggerForSave({ kind: "webhook", filters: { projectId: "p" } }), { kind: "webhook" });
  });

  it("compares triggers by their saved shape", () => {
    assert.ok(triggersEqual({ kind: "task_event", on: "created", filters: { projectId: "" } }, { kind: "task_event", on: "created" }));
    assert.ok(!triggersEqual({ kind: "webhook" }, { kind: "manual" }));
  });

  it("flags an over-long title filter", () => {
    assert.equal(triggerError({ kind: "task_event", on: "created", filters: { titleContains: "x".repeat(121) } }),
      "automation.errors.title_too_long");
    assert.equal(triggerError({ kind: "webhook" }), null);
  });

  it("shows enabled event automations as listening, not unscheduled", () => {
    const base = { id: "R-1", isRoutine: true, routineEnabled: true } as RelayTaskListItem;
    assert.equal(routineState({ ...base, routineTrigger: { kind: "webhook" } }, new Set()), "listening");
    assert.equal(routineState(base, new Set()), "unscheduled");
    assert.equal(routineState({ ...base, routineEnabled: false, routineTrigger: { kind: "webhook" } }, new Set()), "paused");
  });
});

it("compares filters independent of insertion order", () => {
  assert.ok(triggersEqual(
    { kind: "task_event", on: "created", filters: { priority: "high", projectId: "p" } },
    { kind: "task_event", on: "created", filters: { projectId: "p", priority: "high" } },
  ));
});
