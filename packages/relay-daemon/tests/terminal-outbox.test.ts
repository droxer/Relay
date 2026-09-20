import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalOutbox } from "../src/terminal-outbox.js";

test("terminal result survives failed delivery and daemon restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  try {
    const event = { type: "run.completed", commandId: "cmd", leaseId: "lease", runId: "run", exitCode: 0 };
    const outbox = new TerminalOutbox(root);
    const offline = outbox.wrapFetch(async () => { throw new Error("offline"); });
    await assert.rejects(offline("http://backend/events", { method: "POST", body: JSON.stringify(event) }));
    const restarted = new TerminalOutbox(root);
    const received: unknown[] = [];
    await restarted.replay(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }, "http://backend/events", "token");
    assert.deepEqual(received, [event]);
    assert.equal(restarted.pending().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("first terminal result wins and HTTP rejection retains evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  try {
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.completed", commandId: "cmd", leaseId: "lease", exitCode: 0 };
    const send = outbox.wrapFetch(async () => new Response("rejected", { status: 409 }));
    await send("http://backend/events", { method: "POST", body: JSON.stringify(event) });
    await send("http://backend/events", { method: "POST", body: JSON.stringify({ ...event, type: "run.failed" }) });
    assert.deepEqual(outbox.pending()[0].event, event);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("output survives restart and is replayed in sequence before the terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-output-outbox-"));
  try {
    const outbox = new TerminalOutbox(root);
    const output = (sequence: number) => ({ type: "run.output.batch", commandId: "cmd", leaseId: "lease",
      runId: "run", entries: [{ stream: "stdout", text: `chunk-${sequence}`, sequence }] });
    outbox.retain(output(1));
    outbox.retain(output(0));
    outbox.retain({ type: "run.completed", commandId: "cmd", leaseId: "lease", runId: "run" });
    const restarted = new TerminalOutbox(root);
    const received: unknown[] = [];
    await restarted.replay(async (_url, init) => {
      const event = JSON.parse(String(init?.body));
      received.push(event.entries?.[0]?.sequence ?? event.type);
      return new Response("{}", { status: 200 });
    }, "http://backend/events", "token");
    assert.deepEqual(received, [0, 1, "run.completed"]);
    assert.equal(restarted.pending().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay does not skip failed output but still attempts terminal delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-output-order-"));
  try {
    const outbox = new TerminalOutbox(root);
    for (const sequence of [0, 1]) outbox.retain({ type: "run.output.batch", commandId: "cmd", leaseId: "lease",
      entries: [{ stream: "stdout", text: "chunk", sequence }] });
    outbox.retain({ type: "run.completed", commandId: "cmd", leaseId: "lease" });
    let attempts = 0;
    await outbox.replay(async () => { attempts++; return new Response("offline", { status: 503 }); }, "http://backend/events", "token");
    assert.equal(attempts, 2);
    assert.equal(outbox.pending().length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("output quota preserves existing evidence and still allows terminal results", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-output-quota-"));
  try {
    const completed: string[] = [];
    const outbox = new TerminalOutbox(root, id => completed.push(id), 1);
    assert.throws(() => outbox.retain({ type: "run.output", commandId: "cmd", sequence: 0, text: "full" }), /limit exceeded/);
    outbox.retain({ type: "run.failed", commandId: "cmd", error: "storage limit" });
    assert.deepEqual(completed, ["cmd"]);
    assert.equal(outbox.pending().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
