import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("first terminal result wins and transient HTTP rejection retains evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  try {
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.completed", commandId: "cmd", leaseId: "lease", exitCode: 0 };
    const send = outbox.wrapFetch(async () => new Response("unavailable", { status: 503 }));
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

 test("live retry preserves output after replay has finalized the command", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-late-output-"));
  try {
    const outbox = new TerminalOutbox(root);
    const output = { type: "run.output", commandId: "cmd", leaseId: "lease", sequence: 0, text: "chunk" };
    outbox.retain(output);
    outbox.retain({ type: "run.completed", commandId: "cmd", leaseId: "lease" });
    let terminal = false;
    const received: string[] = [];
    const backend: typeof fetch = async (_url, init) => {
      const event = JSON.parse(String(init?.body));
      if (event.type === "run.completed") terminal = true;
      else if (!terminal || event.replayed === true) received.push(event.text);
      return new Response("{}", { status: 200 });
    };
    await outbox.replay(async (url, init) => JSON.parse(String(init?.body)).type === "run.output"
      ? new Response("unavailable", { status: 503 }) : backend(url, init), "http://backend/events", "token");
    assert.equal(terminal, true);
    await outbox.wrapFetch(backend)("http://backend/events", { method: "POST", body: JSON.stringify(output) });
    assert.deepEqual(received, ["chunk"]);
    assert.equal(outbox.pending().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("re-retaining live output does not read the record back from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  try {
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.output.batch", commandId: "cmd", leaseId: "lease", entries: [{ stream: "stdout", text: "x", sequence: 3 }] };
    outbox.retain(event);
    const [name] = readdirSync(root).filter((file) => file.endsWith(".json"));
    // Output identity covers its sequence, so the stored copy is this event;
    // a read-back would only cost a parse on every live post.
    writeFileSync(join(root, name!), "not json");
    assert.deepEqual(outbox.retain(event).event, event);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const status of [400, 401, 403, 404, 409, 410, 422, 408, 429, 503]) {
  for (const delivery of ["live", "replay"]) {
    test(`${delivery} outbox handles HTTP ${status} without retaining permanent rejects`, async () => {
      const root = mkdtempSync(join(tmpdir(), "relay-reject-"));
      try {
        const outbox = new TerminalOutbox(root, undefined, 200);
        const event = { type: "run.output", commandId: "cmd", leaseId: "lease", sequence: 0, text: "chunk" };
        const send: typeof fetch = async () => new Response("rejected", { status });
        if (delivery === "live") await outbox.wrapFetch(send)("http://backend/events", { method: "POST", body: JSON.stringify(event) });
        else { outbox.retain(event); await outbox.replay(send, "http://backend/events", "token"); }
        const retryable = [408, 429, 503].includes(status);
        assert.equal(outbox.pending().length, retryable ? 1 : 0);
        if (!retryable) {
          assert.equal(new TerminalOutbox(root).pending().length, 0);
          assert.doesNotThrow(() => outbox.retain({ ...event, sequence: 1 }));
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
