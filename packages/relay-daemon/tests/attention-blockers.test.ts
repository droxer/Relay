import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRunGate } from "../src/workspace-run-gate.js";
import { TerminalOutbox } from "../src/terminal-outbox.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("cancelling the workspace owner is independent of another waiter's notification", async () => {
  const gate = new WorkspaceRunGate();
  const releaseA = deferred();
  const enteredA = deferred();
  const notification = deferred();
  const notificationStarted = deferred();
  const stopB = new AbortController();
  let bSettled = false;
  let bExecuted = false;
  const a = gate.run("shared", undefined, async () => {
    enteredA.resolve();
    await releaseA.promise;
  }, { sessionId: "a", onWaiting: async () => {} });
  await enteredA.promise;
  const b = gate.run("shared", stopB.signal, async () => { bExecuted = true; }, {
    sessionId: "b", onWaiting: async () => {},
  }).then(() => { bSettled = true; }, () => { bSettled = true; });
  const c = gate.run("shared", undefined, async () => {}, {
    sessionId: "c",
    onWaiting: async owner => {
      if (owner === "b") {
        notificationStarted.resolve();
        await notification.promise;
      }
    },
  });
  try {
    releaseA.resolve();
    await notificationStarted.promise;
    stopB.abort("cancel B while C's status post retries");
    // No wall-clock race: drain several event-loop turns after a known abort.
    for (let i = 0; i < 5; i++) await turn();
    const settledBeforeNotification = bSettled;
    notification.resolve();
    await Promise.all([a, b, c]);
    assert.equal(bSettled, true, "control: releasing C's notification releases B");
    assert.equal(bExecuted, false);
    assert.equal(settledBeforeNotification, true, "B remains blocked by C's unresolved notification after B is cancelled");
  } finally {
    notification.resolve();
    releaseA.resolve();
    await Promise.all([a, b, c]);
  }
});

test("one terminal transport failure does not starve another recoverable result", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-replay-review-"));
  try {
    const outbox = new TerminalOutbox(root);
    for (const commandId of ["a", "b"]) {
      outbox.retain({ type: "run.completed", commandId, leaseId: "lease", exitCode: 0 });
    }
    const [first, second] = outbox.pending();
    const attempts: string[] = [];
    const send: typeof fetch = async (_url, init) => {
      const event = JSON.parse(String(init?.body));
      attempts.push(event.commandId);
      if (event.commandId === first.event.commandId) throw new Error("injected request-specific connection reset");
      return new Response("{}", { status: 200 });
    };
    for (let i = 0; i < 4; i++) await outbox.replay(send, "http://backend.invalid/events", "test-token");
    const retainedBeforeRecovery = outbox.pending().length;
    await outbox.replay(async () => new Response("{}", { status: 200 }), "http://backend.invalid/events", "test-token");
    assert.equal(outbox.pending().length, 0, "control: both records deliver when the first request recovers");
    assert.ok(attempts.includes(String(second.event.commandId)),
      `Second result never attempted; four replay passes attempted only ${JSON.stringify(attempts)}`);
    assert.equal(retainedBeforeRecovery, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
