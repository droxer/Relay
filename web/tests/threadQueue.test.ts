import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_QUEUED_MESSAGES,
  enqueueMessage,
  promoteQueuedMessage,
  removeQueuedMessage,
  shouldDrainQueue,
} from "../src/lib/threadQueue.js";

const queue = [{ id: "a", text: "first" }, { id: "b", text: "second" }, { id: "c", text: "third" }];

describe("thread queue updates", () => {
  it("appends trimmed text and leaves the original untouched", () => {
    const next = enqueueMessage(queue, "  fourth \n", "d");
    assert.deepEqual(next.map((message) => message.text), ["first", "second", "third", "fourth"]);
    assert.equal(queue.length, 3);
  });

  it("ignores blank text and a full queue", () => {
    assert.equal(enqueueMessage(queue, "   ", "d").length, 3);
    const full = Array.from({ length: MAX_QUEUED_MESSAGES }, (_, index) => ({ id: `m${index}`, text: "x" }));
    assert.equal(enqueueMessage(full, "one more", "z").length, MAX_QUEUED_MESSAGES);
  });

  it("promotes the picked message to the head and keeps the rest in order", () => {
    assert.deepEqual(promoteQueuedMessage(queue, "c").map((message) => message.id), ["c", "a", "b"]);
    assert.deepEqual(promoteQueuedMessage(queue, "missing").map((message) => message.id), ["a", "b", "c"]);
  });

  it("removes by id", () => {
    assert.deepEqual(removeQueuedMessage(queue, "b").map((message) => message.id), ["a", "c"]);
  });
});

describe("shouldDrainQueue", () => {
  const ended = { wasRunning: true, running: false, mode: "auto" as const, awaitsPerson: false, queued: 2 };

  it("sends the head when a run ends on its own", () => {
    assert.equal(shouldDrainQueue(ended), true);
  });

  it("needs a run-ended transition, so opening a thread never sends", () => {
    assert.equal(shouldDrainQueue({ ...ended, wasRunning: false }), false);
    assert.equal(shouldDrainQueue({ ...ended, running: true }), false);
    assert.equal(shouldDrainQueue({ ...ended, queued: 0 }), false);
  });

  it("holds the queue after a Stop or while the person is being asked", () => {
    assert.equal(shouldDrainQueue({ ...ended, mode: "paused" }), false);
    assert.equal(shouldDrainQueue({ ...ended, awaitsPerson: true }), false);
  });

  it("sends a steered message even past a Stop or a question", () => {
    assert.equal(shouldDrainQueue({ ...ended, mode: "steer", awaitsPerson: true }), true);
  });
});
