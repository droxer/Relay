import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { taskHoldup } from "../src/lib/taskExceptions.ts";
import { prerequisiteCandidates, waitingOnRefs, waitsOnPrerequisites } from "../src/lib/taskPrerequisites.ts";
import type { RelayTaskListItem } from "../src/types.ts";

function task(fields: Partial<RelayTaskListItem> & { id: string }): RelayTaskListItem {
  return {
    title: fields.id,
    description: "",
    priority: "normal",
    status: "backlog",
    isRoutine: false,
    linkedSessionIds: [],
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
    ...fields,
  };
}

describe("task prerequisites", () => {
  it("names open prerequisites by ref and keeps unknown ids visible", () => {
    const tasks = new Map([["a", task({ id: "a", number: 3 })]]);
    assert.deepEqual(waitingOnRefs({ waitingOn: ["a", "zz"] }, tasks), ["#3", "zz"]);
  });

  it("holds only ready or backlog work", () => {
    assert.equal(waitsOnPrerequisites({ status: "assigned", waitingOn: ["a"] }), true);
    assert.equal(waitsOnPrerequisites({ status: "running", waitingOn: ["a"] }), false);
    assert.equal(waitsOnPrerequisites({ status: "assigned", waitingOn: [] }), false);
  });

  it("is the holdup of a queued task that waits", () => {
    const waiting = task({ id: "b", status: "assigned", waitingOn: ["a"] });
    assert.deepEqual(taskHoldup(waiting), { kind: "prerequisites", ids: ["a"] });
    const blocked = task({ id: "c", status: "blocked", blockerReason: "Key", waitingOn: ["a"] });
    assert.equal(taskHoldup(blocked)?.kind, "blocked", "a block outranks waiting");
  });

  it("offers same-project tasks except itself, automations, and its dependents", () => {
    const self = { id: "b", projectId: "p", unblocks: ["c"] };
    const tasks = [
      task({ id: "a", projectId: "p" }),
      task({ id: "b", projectId: "p" }),
      task({ id: "c", projectId: "p" }),
      task({ id: "d", projectId: "q" }),
      task({ id: "e", projectId: "p", isRoutine: true }),
    ];
    assert.deepEqual(prerequisiteCandidates(self, tasks).map((item) => item.id), ["a"]);
    assert.deepEqual(prerequisiteCandidates({ id: "x" }, tasks), []);
  });
});
