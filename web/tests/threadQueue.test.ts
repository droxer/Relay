import assert from "node:assert/strict";
import { it } from "node:test";
import { applySessionEvent } from "../src/lib/sessionEvents.js";
import type { RelaySession } from "../src/types.js";

it("projects durable queue events without mutating the prior session", () => {
  const session = { id: "thread", events: [], messageQueue: { messages: [], paused: false } } as unknown as RelaySession;
  const queue = { messages: [{ id: "q1", text: "Next step" }], paused: true };
  const event = { id: "queue-event", type: "session.queue" as const, sessionId: "thread", timestamp: "2026-11-12T00:00:00Z", queue };
  const updated = applySessionEvent(session, event);
  assert.deepEqual(updated.messageQueue, queue);
  assert.deepEqual(session.messageQueue?.messages, []);
  assert.equal(applySessionEvent(updated, event), updated);
});
