import assert from "node:assert/strict";
import { it } from "node:test";
import { materializeTaskEvents, relayTaskEvent } from "../../packages/relay-core/src/task-store.js";

it("replays automation configuration and occurrence provenance", () => {
  const created = relayTaskEvent("task.created", "R-1", {
    title: "Triage", description: "", priority: "normal", isRoutine: true,
    routineState: "active", routineTriggers: [{ kind: "webhook" }],
  });
  const updated = relayTaskEvent("task.updated", "R-1", {
    routineTriggers: [], routineState: "paused_by_relay", routinePauseReason: "rate_limited",
  });
  const task = materializeTaskEvents([created, updated]);
  assert.deepEqual(task.routineTriggers, []);
  assert.equal(task.routineState, "paused_by_relay");
  assert.equal(task.routinePauseReason, "rate_limited");
  assert.deepEqual(created.routineTriggers, [{ kind: "webhook" }]);
  const occurrence = materializeTaskEvents([relayTaskEvent("task.created", "T-1", {
    title: "Run", description: "", priority: "normal", sourceRoutineId: "R-1",
    routineTriggerKind: "manual", routineTriggerDepth: 2,
  })]);
  assert.equal(occurrence.routineTriggerKind, "manual");
  assert.equal(occurrence.routineTriggerDepth, 2);
});
