import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { AGENT_NAMES, getAgent, type DaemonNodeEvent, type PermissionPromptAdapter } from "relay-core";

import { permissionPromptsApply, startPermissionBroker, type PermissionBrokerOptions } from "../src/permission-broker.js";
import { permissionAdapterLaunch, permissionAdapterScript } from "../src/permission-adapters/index.js";
import { askBroker, runtimeEnv, type PermissionQuestion } from "../src/permission-adapters/protocol.js";

/** Asks the broker at `socket` the way every adapter does. */
function brokerClient(socket: string, secret: string) {
  return (question: Omit<PermissionQuestion, "kind"> & { kind?: PermissionQuestion["kind"] }) =>
    askBroker({ kind: "tool", ...question }, { RELAY_PERMISSION_SOCKET: socket, RELAY_PERMISSION_SECRET: secret });
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
    const env = broker.env;
    return await brokerClient(env.RELAY_PERMISSION_SOCKET, env.RELAY_PERMISSION_SECRET)(request);
  } finally {
    await broker.close();
  }
}

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
      const env = broker.env;
      const pending = brokerClient(env.RELAY_PERMISSION_SOCKET, env.RELAY_PERMISSION_SECRET)({ toolName: "Write", input: {} });
      while (h.polls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      run.abort("Cancelled by human.");
      const decision = await pending;
      assert.equal(decision.behavior, "deny");
      assert.match((decision as { message: string }).message, /Cancelled by human/);
      const polled = h.polls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(h.polls.length, polled);
    } finally {
      await broker.close();
    }
  });

  it("refuses a caller without the run's secret and asks nobody", async () => {
    const h = harness([json({ status: "allow" })]);
    const broker = await startPermissionBroker(h.options);
    try {
      const decision = await brokerClient(broker.env.RELAY_PERMISSION_SOCKET, "wrong")({ toolName: "Write", input: {} });
      assert.equal(decision.behavior, "deny");
      assert.equal(h.posted.length, 0);
    } finally {
      await broker.close();
    }
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
      const client = brokerClient(broker.env.RELAY_PERMISSION_SOCKET, broker.env.RELAY_PERMISSION_SECRET);
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

  it("serves a private socket it removes on close", async () => {
    const h = harness([json({ status: "allow" })]);
    const broker = await startPermissionBroker(h.options);
    assert.equal(broker.env.RELAY_PERMISSION_SOCKET, broker.socketPath);
    assert.match(broker.env.RELAY_PERMISSION_SECRET, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(broker.socketPath));
    await broker.close();
    assert.equal(existsSync(dirname(broker.socketPath)), false);
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
    const env = { RELAY_PERMISSION_SOCKET: "/tmp/s.sock", RELAY_PERMISSION_SECRET: "abc" };
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
  it("keeps the broker's address and secret away from the runtime and its tools", () => {
    const env = runtimeEnv({ PATH: "/usr/bin", HOME: "/home/a", RELAY_PERMISSION_SOCKET: "/tmp/s", RELAY_PERMISSION_SECRET: "x", RELAY_BACKEND_URL: "http://b" });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/a", RELAY_BACKEND_URL: "http://b" });
  });
});
