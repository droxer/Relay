import assert from "node:assert/strict";
import { it } from "node:test";
import { materializeTaskEvents, relayTaskEvent } from "../../packages/relay-core/src/task-store.js";

it("replays automation configuration and occurrence provenance", () => {
  const created = relayTaskEvent("task.created", "R-1", {
    title: "Triage", description: "", priority: "normal", isRoutine: true,
    routineEnabled: true, routineTrigger: { kind: "webhook" },
  });
  const updated = relayTaskEvent("task.updated", "R-1", {
    routineTrigger: { kind: "manual" }, routineDisabledReason: "rate_limited",
  });
  const task = materializeTaskEvents([created, updated]);
  assert.deepEqual(task.routineTrigger, { kind: "manual" });
  assert.equal(task.routineDisabledReason, "rate_limited");
  assert.deepEqual(created.routineTrigger, { kind: "webhook" });
  const occurrence = materializeTaskEvents([relayTaskEvent("task.created", "T-1", {
    title: "Run", description: "", priority: "normal", sourceRoutineId: "R-1",
    routineTriggerKind: "task_event", routineTriggerDepth: 2,
  })]);
  assert.equal(occurrence.routineTriggerKind, "task_event");
  assert.equal(occurrence.routineTriggerDepth, 2);
});
