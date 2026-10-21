import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_NAMES, getAgent, type DaemonNodeEvent, type PermissionPromptAdapter } from "relay-core";

import { permissionPromptsApply, permissionTimeoutMs, startPermissionBroker, type PermissionBrokerOptions } from "../src/permission-broker.js";
import { permissionAdapterLaunch, permissionAdapterScript } from "../src/permission-adapters/index.js";
import { askBroker, brokerAddress, runtimeEnv, type PermissionQuestion } from "../src/permission-adapters/protocol.js";

const scratch = mkdtempSync(join(tmpdir(), "relay-broker-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** An address file naming `socket` and `secret`, as the broker writes one. */
function addressFile(socket: string, secret: string): string {
  const file = join(scratch, `address-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ socket, secret }));
  return file;
}

/** Asks the broker behind `env` the way every adapter does. */
function brokerClient(env: { RELAY_PERMISSION_FILE: string }) {
  return (question: Omit<PermissionQuestion, "kind"> & { kind?: PermissionQuestion["kind"] }) =>
    askBroker({ kind: "tool", ...question }, env);
}

const command = { id: "cmd-1", sessionId: "session-1", runId: "run-1", agent: "claude" as const, leaseId: "lease-1" };

interface Harness {
  options: PermissionBrokerOptions;
  posted: DaemonNodeEvent[];
  polls: Array<{ url: string; authorization: string | null }>;
}

/** `answers` are served to successive polls; the last one repeats. */
function harness(
  answers: Array<() => Response | Promise<Response>>,
  overrides: Partial<PermissionBrokerOptions> = {},
): Harness {
  const posted: DaemonNodeEvent[] = [];
  const polls: Harness["polls"] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    polls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    const answer = answers[Math.min(polls.length - 1, answers.length - 1)];
    return await answer();
  }) as typeof fetch;
  return {
    posted,
    polls,
    options: {
      fetchFn,
      backendUrl: "http://backend.test",
      sandboxId: "sandbox/1",
      token: "node-token",
      command,
      postEvent: async (event) => { posted.push(event); },
      pollIntervalMs: 5,
      ...overrides,
    },
  };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

async function ask(options: PermissionBrokerOptions, request: Omit<PermissionQuestion, "kind"> & { kind?: PermissionQuestion["kind"] }) {
  const broker = await startPermissionBroker(options);
  try {
    return await brokerClient(broker.env)(request);
  } finally {
    await broker.close();
  }
}

const withdrawn = (posted: DaemonNodeEvent[]) =>
  posted.filter((event): event is Extract<DaemonNodeEvent, { type: "run.permission_withdrawn" }> => event.type === "run.permission_withdrawn");

describe("permission broker", () => {
  it("posts the request, then polls until a person allows it", async () => {
    const h = harness([json({ status: "pending" }), json({ status: "pending" }), json({ status: "allow" })]);
    const decision = await ask(h.options, { toolName: "Write", input: { file_path: "a.txt" }, toolUseId: "toolu_1" });
    assert.deepEqual(decision, { behavior: "allow" });
    assert.equal(h.posted.length, 1);
    const event = h.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>;
    assert.match(event.request.id, /^perm_[0-9a-f]+$/);
    assert.deepEqual(event, {
      type: "run.permission_requested",
      commandId: "cmd-1",
      leaseId: "lease-1",
      sessionId: "session-1",
      runId: "run-1",
      agent: "claude",
      request: { id: event.request.id, toolName: "Write", toolUseId: "toolu_1", input: "{\"file_path\":\"a.txt\"}" },
    });
    assert.equal(h.polls.length, 3);
    const url = new URL(h.polls[0].url);
    assert.equal(url.pathname, `/api/v1/daemon-nodes/sandbox%2F1/permission-requests/${event.request.id}`);
    assert.equal(url.searchParams.get("sessionId"), "session-1");
    assert.equal(h.polls[0].authorization, "Bearer node-token");
  });

  it("relays a denial with the person's note, or a default message", async () => {
    const noted = harness([json({ status: "deny", note: "Use the staging bucket." })]);
    assert.deepEqual(await ask(noted.options, { toolName: "Bash", input: {} }), { behavior: "deny", message: "Use the staging bucket." });
    const bare = harness([json({ status: "deny" })]);
    assert.deepEqual(await ask(bare.options, { toolName: "Bash", input: {} }), { behavior: "deny", message: "Denied by the user in Relay." });
  });

  it("denies an expired request", async () => {
    const h = harness([json({ status: "expired" })]);
    assert.deepEqual(await ask(h.options, { toolName: "Bash", input: {} }), { behavior: "deny", message: "The permission request expired." });
  });

  it("keeps polling through network errors and 5xx answers", async () => {
    const h = harness([
      () => { throw new TypeError("fetch failed"); },
      json({ error: "unavailable" }, 503),
      json({ status: "allow" }),
    ]);
    assert.deepEqual(await ask(h.options, { toolName: "Write", input: {} }), { behavior: "allow" });
    assert.equal(h.polls.length, 3);
  });

  it("denies and stops polling when the backend does not know the request", async () => {
    for (const status of [404, 410, 401, 403]) {
      const h = harness([json({ detail: "gone" }, status)]);
      const decision = await ask(h.options, { toolName: "Write", input: {} });
      assert.equal(decision.behavior, "deny");
      assert.match((decision as { message: string }).message, /Relay could not ask a person/);
      assert.equal(h.polls.length, 1);
    }
  });

  it("denies without polling when the backend refuses the event", async () => {
    const h = harness([json({ status: "allow" })], {
      postEvent: async () => { throw new Error("POST failed: 422 unknown event type"); },
    });
    const decision = await ask(h.options, { toolName: "Write", input: {} });
    assert.equal(decision.behavior, "deny");
    assert.match((decision as { message: string }).message, /Relay could not ask a person/);
    assert.equal(h.polls.length, 0);
  });

  it("denies an open question when the run is cancelled", async () => {
    const run = new AbortController();
    const h = harness([json({ status: "pending" })], { signal: run.signal });
    const broker = await startPermissionBroker(h.options);
    try {
      const pending = brokerClient(broker.env)({ toolName: "Write", input: {} });
      while (h.polls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      run.abort("Cancelled by human.");
      const decision = await pending;
      assert.equal(decision.behavior, "deny");
      assert.match((decision as { message: string }).message, /Cancelled by human/);
      const polled = h.polls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(h.polls.length, polled);
      // The run ending expires its prompts on the backend; nothing to withdraw.
      assert.equal(withdrawn(h.posted).length, 0);
    } finally {
      await broker.close();
    }
  });

  it("withdraws a prompt nobody answered before the deadline, and denies it", async () => {
    const h = harness([json({ status: "pending" })], { timeoutMs: 40 });
    const decision = await ask(h.options, { toolName: "Write", input: {} });
    assert.equal(decision.behavior, "deny");
    assert.match((decision as { message: string }).message, /No one answered in time/);
    const [event] = withdrawn(h.posted);
    const request = (h.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request;
    assert.deepEqual(event, {
      type: "run.permission_withdrawn", commandId: "cmd-1", leaseId: "lease-1", sessionId: "session-1", runId: "run-1", agent: "claude",
      requestId: request.id, reason: "No one answered in time.",
    });
  });

  it("withdraws a prompt whose runtime hung up before the answer", async () => {
    const h = harness([json({ status: "pending" })]);
    const broker = await startPermissionBroker(h.options);
    try {
      const { connect } = await import("node:net");
      const address = brokerAddress(broker.env)!;
      const socket = connect(address.socket);
      await new Promise<void>((resolve) => socket.on("connect", resolve));
      socket.write(`${JSON.stringify({ secret: address.secret, kind: "tool", toolName: "Write", input: {} })}\n`);
      while (h.polls.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      socket.destroy();
      while (withdrawn(h.posted).length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(withdrawn(h.posted)[0].reason, "The permission prompt disconnected.");
    } finally {
      await broker.close();
    }
  });

  it("reads the deadline from the environment, 0 waiting forever", () => {
    assert.equal(permissionTimeoutMs({}), 30 * 60_000);
    assert.equal(permissionTimeoutMs({ RELAY_DAEMON_PERMISSION_TIMEOUT_MS: "5000" }), 5000);
    assert.equal(permissionTimeoutMs({ RELAY_DAEMON_PERMISSION_TIMEOUT_MS: "0" }), 0);
    assert.equal(permissionTimeoutMs({ RELAY_DAEMON_PERMISSION_TIMEOUT_MS: "soon" }), 30 * 60_000);
  });

  it("refuses a caller without the run's secret and asks nobody", async () => {
    const h = harness([json({ status: "allow" })]);
    const broker = await startPermissionBroker(h.options);
    try {
      const decision = await brokerClient({ RELAY_PERMISSION_FILE: addressFile(broker.socketPath, "wrong") })({ toolName: "Write", input: {} });
      assert.equal(decision.behavior, "deny");
      assert.equal(h.posted.length, 0);
      const unconfigured = await askBroker({ kind: "tool", toolName: "Write", input: {} }, {});
      assert.match(unconfigured.message ?? "", /not configured/);
    } finally {
      await broker.close();
    }
  });

  it("carries a question's choices to the backend and the person's answers back", async () => {
    const h = harness([json({ status: "allow", answers: { "Which?": ["B"], ignored: [] } })]);
    const questions = [{ id: "Which?", text: "Which?", options: [{ label: "A" }, { label: "B", description: "second" }], multiSelect: true }];
    const decision = await ask(h.options, { kind: "question", toolName: "AskUserQuestion", input: { questions: [] }, questions });
    assert.deepEqual(decision, { behavior: "allow", answers: { "Which?": ["B"] } });
    const request = (h.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request;
    assert.deepEqual(request.questions, questions);
    // A question with no well-formed questions is an ordinary approval.
    const plain = harness([json({ status: "allow" })]);
    await ask(plain.options, { kind: "question", toolName: "AskUserQuestion", input: {}, questions: [{ id: "", text: "", options: [] }] });
    assert.equal((plain.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request.questions, undefined);
  });

  it("answers overlapping questions independently", async () => {
    const h = harness([json({ status: "pending" })]);
    let posts = 0;
    const decisions = new Map<string, string>();
    h.options.postEvent = async (event) => {
      posts += 1;
      const request = (event as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request;
      decisions.set(request.id, request.toolName === "Bash" ? "deny" : "allow");
    };
    h.options.fetchFn = (async (input: string | URL | Request) => {
      const id = new URL(String(input)).pathname.split("/").pop() ?? "";
      return new Response(JSON.stringify({ status: decisions.get(id) ?? "pending" }));
    }) as typeof fetch;
    const broker = await startPermissionBroker(h.options);
    try {
      const client = brokerClient(broker.env);
      const [write, bash] = await Promise.all([
        client({ toolName: "Write", input: {} }),
        client({ toolName: "Bash", input: {} }),
      ]);
      assert.equal(write.behavior, "allow");
      assert.equal(bash.behavior, "deny");
      assert.equal(posts, 2);
    } finally {
      await broker.close();
    }
  });

  it("caps the tool input it sends", async () => {
    const h = harness([json({ status: "allow" })]);
    await ask(h.options, { toolName: "Write", input: { content: "x".repeat(10_000) } });
    const input = (h.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request.input;
    assert.equal(input.length, 4000);
    assert.ok(input.endsWith("…"));
  });

  it("serves a private socket and a 0600 address file, both removed on close", async () => {
    const h = harness([json({ status: "allow" })]);
    const broker = await startPermissionBroker(h.options);
    const file = broker.env.RELAY_PERMISSION_FILE;
    assert.equal(file, join(broker.privateDir, "broker.json"));
    assert.equal(statSync(broker.privateDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const address = JSON.parse(readFileSync(file, "utf8")) as { socket: string; secret: string };
    assert.equal(address.socket, broker.socketPath);
    assert.match(address.secret, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(broker.socketPath));
    // Only the file's path reaches a runtime, never the secret.
    assert.deepEqual(Object.keys(broker.env), ["RELAY_PERMISSION_FILE"]);
    await broker.close();
    assert.equal(existsSync(broker.privateDir), false);
  });

  it("carries a question's kind and reason, folding the reason into the shown input", async () => {
    const h = harness([json({ status: "allow" })]);
    await ask(h.options, { kind: "command", toolName: "Bash", input: { command: "touch /x" }, reason: "needs /x" });
    const request = (h.posted[0] as Extract<DaemonNodeEvent, { type: "run.permission_requested" }>).request;
    assert.equal(request.input, "{\"command\":\"touch /x\",\"reason\":\"needs /x\"}");
  });
});

describe("permission adapter launch", () => {
  it("runs each adapter's compiled script with the daemon's node and the broker env", () => {
    const env = { RELAY_PERMISSION_FILE: "/tmp/relay-perm-x/broker.json" };
    const adapters = new Set<PermissionPromptAdapter>();
    for (const name of AGENT_NAMES) {
      const support = getAgent(name).permissionPrompts;
      assert.equal(support.kind, "adapter", `${name} declares an adapter`);
      if (support.kind === "adapter") adapters.add(support.adapter);
    }
    assert.deepEqual([...adapters].sort(), ["claude-mcp", "codex-app-server", "kimi-acp", "pi-extension"]);
    for (const adapter of adapters) {
      const launch = permissionAdapterLaunch(adapter, { env });
      assert.equal(launch.adapter, adapter);
      assert.equal(launch.command, process.execPath);
      assert.deepEqual(launch.args, [permissionAdapterScript(adapter)]);
      assert.deepEqual(launch.env, env);
      assert.match(permissionAdapterScript(adapter), new RegExp(`permission-adapters[\\\\/]${adapter}\\.js$`));
      assert.ok(existsSync(permissionAdapterScript(adapter)), `${adapter} compiled script exists`);
    }
  });
});

describe("permissionPromptsApply", () => {
  it("follows the registry: runtimes with an adapter, on a local computer, under the native policy", () => {
    assert.equal(permissionPromptsApply("claude", "none", {}), true);
    assert.equal(permissionPromptsApply("claude", "none", { RELAY_LOCAL_PERMISSION_POLICY: "native" }), true);
    assert.equal(permissionPromptsApply("claude", "none", { RELAY_LOCAL_PERMISSION_POLICY: "trusted" }), false);
    assert.equal(permissionPromptsApply("claude", "boxlite", {}), false);
    assert.equal(permissionPromptsApply("codex", "none", {}), true);
    assert.equal(permissionPromptsApply("kimi", "none", {}), true);
    assert.equal(permissionPromptsApply("pi", "none", {}), true);
    assert.equal(permissionPromptsApply("pi", "boxlite", {}), false);
  });
});

describe("runtimeEnv", () => {
  it("keeps the broker's address away from the runtime and its tools", () => {
    const env = runtimeEnv({ PATH: "/usr/bin", HOME: "/home/a", RELAY_PERMISSION_FILE: "/tmp/s/broker.json", RELAY_BACKEND_URL: "http://b" });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/a", RELAY_BACKEND_URL: "http://b" });
  });
});
