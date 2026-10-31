import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    await outbox.flush();
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

test("re-retaining live output does not read the record back from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  try {
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.output.batch", commandId: "cmd", leaseId: "lease", entries: [{ stream: "stdout", text: "x", sequence: 3 }] };
    outbox.retain(event);
    await outbox.flush();
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
          await outbox.flush();
          assert.equal(new TerminalOutbox(root).pending().length, 0);
          assert.doesNotThrow(() => outbox.retain({ ...event, sequence: 1 }));
        }
        await outbox.flush();
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test("output batches are retained write-behind while terminal events stay synchronous", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-write-behind-"));
  try {
    const outbox = new TerminalOutbox(root);
    const output = (sequence: number) => ({ type: "run.output.batch", commandId: "cmd", leaseId: "lease",
      entries: [{ stream: "stdout", text: `chunk-${sequence}`, sequence }] });
    // The record is accounted for at once (quota, ordering, pending) and
    // lands on disk later.
    outbox.retain(output(0));
    assert.equal(outbox.pending().length, 1);
    assert.deepEqual(outbox.retain(output(0)).event, output(0));
    await outbox.flush();
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(outbox.pending().length, 1);
    // A terminal event is on disk before retain returns: it is the only
    // evidence the run ended.
    outbox.retain({ type: "run.completed", commandId: "cmd", leaseId: "lease" });
    assert.equal(outbox.pending().length, 2);
    // Output acknowledged while its write is still landing leaves nothing
    // behind for replay once the write completes.
    const send = outbox.wrapFetch(async () => new Response("{}", { status: 200 }));
    await send("http://backend/events", { method: "POST", body: JSON.stringify({ ...output(0), commandId: "other" }) });
    await outbox.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(outbox.pending().map((record) => record.event.type), ["run.output.batch", "run.completed"]);
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed write-behind output record is reported, not thrown on the hot path", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-write-behind-error-"));
  try {
    const errors: string[] = [];
    const outbox = new TerminalOutbox(root, undefined, undefined, (error) => errors.push(error.message));
    rmSync(root, { recursive: true, force: true });
    outbox.retain({ type: "run.output.batch", commandId: "cmd", leaseId: "lease", entries: [{ stream: "stdout", text: "x", sequence: 0 }] });
    await outbox.flush();
    assert.equal(errors.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("failed output writes remain replayable and do not block subsequent live output", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-write-recovery-"));
  const errors: Error[] = [];
  const output = (sequence: number) => ({ type: "run.output", commandId: "cmd", leaseId: "lease", sequence, text: "chunk" });
  const outbox = new TerminalOutbox(root, undefined, Buffer.byteLength(JSON.stringify(output(0))), error => errors.push(error));
  try {
    rmSync(root, { recursive: true });
    const offline = outbox.wrapFetch(async () => { throw new Error("offline"); });
    await assert.rejects(offline("http://backend/events", { method: "POST", body: JSON.stringify(output(0)) }));
    await outbox.flush();
    assert.equal(errors.length, 1);
    mkdirSync(root);
    assert.deepEqual(outbox.pending().map(record => record.event.sequence), [0]);
    assert.throws(() => outbox.retain(output(1)), /limit exceeded/);
    await outbox.replay(async () => new Response("offline", { status: 503 }), "http://backend/events", "token");
    assert.deepEqual(outbox.pending().map(record => record.event.sequence), [0]);
    const received: number[] = [];
    const backend: typeof fetch = async (_url, init) => {
      received.push(JSON.parse(String(init?.body)).sequence);
      return new Response("{}");
    };
    await outbox.replay(backend, "http://backend/events", "token");
    assert.deepEqual(received, [0]);
    const result = await outbox.wrapFetch(backend)("http://backend/events", { method: "POST", body: JSON.stringify(output(1)) });
    assert.equal(result.status, 200);
    await outbox.flush();
    assert.deepEqual(received, [0, 1]);
    assert.equal(outbox.pending().length, 0);
  } finally {
    await outbox.flush();
    rmSync(root, { recursive: true, force: true });
  }
});


test("large successful completions fit the backend body limit without losing artifact metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-large-completion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outbox = new TerminalOutbox(root);
  const files = Array.from({ length: 3 }, (_, index) => ({
    relativePath: `report-${index}.txt`, bytes: 1_100_000,
    contentBase64: Buffer.alloc(1_100_000, 65).toString("base64"),
  }));
  const event = { type: "run.completed", commandId: "cmd", exitCode: 0, generatedFiles: files };
  const send = outbox.wrapFetch(async (_url, init) => {
    assert.ok(Buffer.byteLength(String(init?.body)) < 4 * 1024 * 1024);
    const received = JSON.parse(String(init?.body));
    assert.equal(received.type, "run.completed");
    assert.equal(received.exitCode, 0);
    assert.deepEqual(received.generatedFiles.map((file: { relativePath: string }) => file.relativePath), files.map(file => file.relativePath));
    assert.ok(received.generatedFiles.some((file: { snapshotSkipped?: string }) => file.snapshotSkipped === "too-large"));
    return new Response("{}", { status: 202 });
  });
  await send("http://backend/events", { method: "POST", body: JSON.stringify(event) });
  assert.equal(outbox.pending().length, 0);
  assert.ok(files.every(file => file.contentBase64), "the caller's evidence is not mutated");
});

for (const delivery of ["live", "replay"]) {
  test(`${delivery} completion retries HTTP 413 without inline attachments and keeps its outcome`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "relay-small-body-limit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.completed", commandId: "cmd", exitCode: 0, agentLog: "Done",
      generatedFiles: [{ relativePath: "report.txt", bytes: 100, contentBase64: "YQ==" }] };
    let attempts = 0;
    const backend: typeof fetch = async (_url, init) => {
      attempts++;
      const received = JSON.parse(String(init?.body));
      if (received.generatedFiles[0].contentBase64) return new Response("too big", { status: 413 });
      assert.equal(received.type, "run.completed");
      assert.equal(received.exitCode, 0);
      assert.equal(received.generatedFiles[0].relativePath, "report.txt");
      return new Response("{}", { status: 202 });
    };
    if (delivery === "live") await outbox.wrapFetch(backend)("http://backend/events", { method: "POST", body: JSON.stringify(event) });
    else { outbox.retain(event); await outbox.replay(backend, "http://backend/events", "token"); }
    assert.equal(attempts, 2);
    assert.equal(outbox.pending().length, 0);
  });
}

for (const delivery of ["live", "replay"]) {
  test(`${delivery} preserves exit evidence when even the compact terminal payload is rejected`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "relay-terminal-rejected-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outbox = new TerminalOutbox(root);
    const event = { type: "run.completed", commandId: "cmd", exitCode: 0, agentLog: "Done" };
    const reject: typeof fetch = async () => new Response("too big", { status: 413 });
    if (delivery === "live") {
      const response = await outbox.wrapFetch(reject)("http://backend/events", { method: "POST", body: JSON.stringify(event) });
      assert.equal(response.status, 503, "the producer must retry instead of reporting a different outcome");
    } else {
      outbox.retain(event);
      await outbox.replay(reject, "http://backend/events", "token");
    }
    const restarted = new TerminalOutbox(root);
    assert.equal(restarted.pending().length, 1);
    await restarted.replay(async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), event);
      return new Response("{}", { status: 202 });
    }, "http://backend/events", "token");
    assert.equal(restarted.pending().length, 0);
  });
}
