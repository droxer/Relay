import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { applySessionEvent, shareSessions } from "../src/lib/sessionEvents.js";
import { mergeSessionSnapshotIntoSessions } from "../src/lib/sessionPollMerge.js";
import {
  activeWorkflowRun,
  workflowDecisionBinding,
  workflowSnapshotDue,
  workflowStepStates,
} from "../src/lib/workflowRuns.js";
import type { RelaySession } from "../src/types.js";

type Expected = Pick<RelaySession, "workflowRuns" | "activeWorkflowRunId" | "status">;
type Scenario = { base: RelaySession; steps: Array<{ event: RelaySession["events"][number]; expected: Expected }> };

// Generated from the backend reducer and pinned by
// backend/tests/unit/test_workflow_client_parity.py.
const fixture = JSON.parse(
  readFileSync(resolve("web/tests/fixtures/workflow-events.json"), "utf8"),
) as Record<"progression" | "rejection", Scenario>;

/** Events only the backend can project; the client must refetch, not guess. */
const SNAPSHOT_ONLY = new Set(["workflow.step_finished", "workflow.recovery_decided:retry"]);

function key(event: RelaySession["events"][number]): string {
  return event.type === "workflow.recovery_decided" ? `${event.type}:${event.kind}` : event.type;
}

function projection(session: Pick<RelaySession, "workflowRuns" | "activeWorkflowRunId" | "status">) {
  return {
    workflowRuns: session.workflowRuns ?? null,
    activeWorkflowRunId: session.activeWorkflowRunId ?? null,
    status: session.status,
  };
}

function base(scenario: Scenario): RelaySession {
  return { ...scenario.base, events: [] } as RelaySession;
}

/** The authoritative snapshot the backend would serve after `index`. */
function served(scenario: Scenario, index: number): RelaySession {
  const { expected } = scenario.steps[index];
  const snapshot: RelaySession = {
    ...base(scenario),
    events: scenario.steps.slice(0, index + 1).map(step => step.event),
    status: expected.status,
  };
  if (expected.workflowRuns) snapshot.workflowRuns = expected.workflowRuns;
  if (expected.activeWorkflowRunId) snapshot.activeWorkflowRunId = expected.activeWorkflowRunId;
  return snapshot;
}

describe("workflow event projection parity", () => {
  for (const [name, scenario] of Object.entries(fixture)) {
    it(`matches the backend reducer for the ${name} scenario`, () => {
      let session = base(scenario);
      scenario.steps.forEach((step, index) => {
        session = applySessionEvent(session, step.event);
        if (workflowSnapshotDue(session) !== undefined) {
          assert.ok(SNAPSHOT_ONLY.has(key(step.event)), `${key(step.event)} must project locally`);
          // A refetch replaces the cached record with the served snapshot.
          session = mergeSessionSnapshotIntoSessions([session], served(scenario, index))[0];
          assert.equal(workflowSnapshotDue(session), undefined);
        } else {
          assert.ok(!SNAPSHOT_ONLY.has(key(step.event)), `${key(step.event)} must not be guessed`);
        }
        assert.deepEqual(projection(session), projection(step.expected), `after ${key(step.event)}`);
      });
    });
  }

  it("keeps a newer streamed decision when a stale snapshot arrives", () => {
    const scenario = fixture.progression;
    const started = served(scenario, 0);
    const streamed = applySessionEvent(started, scenario.steps[1].event);
    const merged = mergeSessionSnapshotIntoSessions([streamed], started, applySessionEvent)[0];
    assert.equal(activeWorkflowRun(merged)?.status, "ready");
    assert.equal(activeWorkflowRun(merged)?.revision, 1);
  });

  it("marks a stale-revision decision as owing a snapshot instead of applying it", () => {
    const started = served(fixture.progression, 0);
    const event = { ...fixture.progression.steps[1].event, id: "evt-stale", expectedRevision: 7 } as RelaySession["events"][number];
    const next = applySessionEvent(started, event);
    assert.equal(activeWorkflowRun(next)?.status, "awaiting_approval");
    assert.equal(workflowSnapshotDue(next), next.events.length);
  });

  it("does not let structural sharing keep a session that owes a snapshot", () => {
    const scenario = fixture.progression;
    const owed = applySessionEvent(served(scenario, 3), scenario.steps[4].event);
    const fresh = served(scenario, 4);
    const shared = shareSessions([{ ...owed, updatedAt: fresh.updatedAt }], [{ ...fresh, updatedAt: fresh.updatedAt }]);
    assert.notEqual(workflowSnapshotDue(shared[0]), workflowSnapshotDue(owed));
  });

  it("derives step states and the current decision binding", () => {
    const run = activeWorkflowRun(served(fixture.progression, 5))!;
    assert.deepEqual(workflowStepStates(run), ["done", "blocked", "pending"]);
    assert.deepEqual(workflowDecisionBinding(run), {
      workflowRunId: run.workflowRunId,
      workflowStepId: "build",
      workflowAttempt: 1,
      assignmentId: run.assignments[1].assignmentId,
      expectedRevision: 3,
    });
  });
});
