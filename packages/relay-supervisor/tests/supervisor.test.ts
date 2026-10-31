import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPanelDaemonNodeRecord } from "relay-core";
import { SupervisorBackendClient } from "../src/backend-client.js";
import { defaultWorkspaceRoot, type WorkspaceRootFs } from "../src/workspace-root.js";
import { CommandTemplateLauncher, LocalDaemonLauncher, workspaceForUser, workspaceForManagedNode } from "../src/launchers.js";
import { RelaySupervisor } from "../src/reconcile.js";
import type {
  DaemonLaunchRequest,
  DaemonLauncher,
  UserRecord,
  ManagedDaemon,
  ProvisionedDaemonNode,
  SupervisorBackend,
} from "../src/types.js";

function node(input: Partial<ControlPanelDaemonNodeRecord> & { id: string; userId: string }): ControlPanelDaemonNodeRecord {
  return {
    id: input.id,
    userId: input.userId,
    workspacePath: input.workspacePath,
    status: input.status ?? "provisioning",
    agents: input.agents ?? { claude: "unknown", pi: "unknown", codex: "unknown", kimi: "unknown", opencode: "unknown" },
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    queuedCommandCount: input.queuedCommandCount ?? 0,
    activeRuns: input.activeRuns ?? [],
    online: input.online ?? false,
    stale: input.stale ?? true,
    nodeToken: input.nodeToken,
  };
}

class FakeBackend implements SupervisorBackend {
  provisionCalls: Array<{ userId: string; workspacePath?: string }> = [];

  constructor(
    private readonly users: UserRecord[],
    private readonly nodes: ControlPanelDaemonNodeRecord[],
  ) {}

  async listUsers(): Promise<UserRecord[]> {
    return this.users;
  }

  async listDaemonNodes(): Promise<ControlPanelDaemonNodeRecord[]> {
    return this.nodes;
  }

  async provisionDaemonNode(input: { userId: string; workspacePath?: string }): Promise<ProvisionedDaemonNode> {
    this.provisionCalls.push(input);
    const existing = this.nodes.find((item) => item.userId === input.userId);
    const next = existing ?? node({
      id: `sbx_${input.userId}`,
      userId: input.userId,
      workspacePath: input.workspacePath,
      nodeToken: `tok_${input.userId}`,
    });
    if (!existing) this.nodes.push(next);
    return {
      node: next,
      nodeToken: next.nodeToken,
      daemonEnv: {
        RELAY_BACKEND_URL: "http://backend.test",
        RELAY_SANDBOX_ID: next.id,
        RELAY_USER_ID: input.userId,
        RELAY_DAEMON_NODE_TOKEN: next.nodeToken ?? "",
        RELAY_WORKSPACE: input.workspacePath ?? "",
      },
    };
  }
}

class FakeLauncher implements DaemonLauncher {
  readonly name = "fake";
  readonly starts: DaemonLaunchRequest[] = [];

  async start(request: DaemonLaunchRequest): Promise<ManagedDaemon> {
    this.starts.push(request);
    return {
      key: `${request.user.id}:${request.node.id}`,
      provider: this.name,
      async stop() {},
    };
  }
}

class ExitedChildLauncher implements DaemonLauncher {
  readonly name = "exited-child";
  readonly starts: DaemonLaunchRequest[] = [];

  async start(request: DaemonLaunchRequest): Promise<ManagedDaemon> {
    this.starts.push(request);
    const child = {
      exitCode: this.starts.length === 1 ? 1 : null,
      signalCode: null,
    } as ChildProcess;
    return {
      key: `${request.user.id}:${request.node.id}`,
      provider: this.name,
      child,
      async stop() {},
    };
  }
}

test("supervisor provisions and starts missing user daemon nodes", async () => {
  const backend = new FakeBackend([{ id: "alice" }], []);
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForUser: (user) => `/workspaces/${user.id}`,
  });

  const result = await supervisor.reconcileOnce();

  assert.deepEqual(result, { users: 1, provisioned: 1, started: 1, skipped: 0 });
  assert.deepEqual(backend.provisionCalls, [{ userId: "alice", workspacePath: "/workspaces/alice" }]);
  assert.equal(launcher.starts[0].node.id, "sbx_alice");
  assert.equal(launcher.starts[0].env.RELAY_DAEMON_NODE_TOKEN, "tok_alice");
});

test("local supervisor launcher defaults daemon nodes to BoxLite mode", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "relay-supervisor-launcher-"));
  try {
    const launcher = new LocalDaemonLauncher({
      backendUrl: "http://backend.test",
      workspaceRoot,
      command: "/usr/bin/true",
    });
    const managed = await launcher.start({
      user: { id: "alice" },
      node: node({ id: "sbx_alice", userId: "alice", nodeToken: "tok_alice" }),
      workspacePath: join(workspaceRoot, "alice"),
      env: { RELAY_DAEMON_NODE_TOKEN: "tok_alice" },
    });

    assert.ok(managed.child?.spawnargs.includes("boxlite"));
    await managed.stop();
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("managed user workspaces are absolute when the configured root is relative", () => {
  assert.equal(workspaceForUser(".relay-workspaces", "alice"), join(process.cwd(), ".relay-workspaces/alice"));
});

test("managed cloud computers receive distinct node workspace roots", () => {
  assert.equal(
    workspaceForManagedNode(".relay/managed-workspaces", "mnode_cloud_1"),
    join(process.cwd(), ".relay/managed-workspaces/mnode_cloud_1"),
  );
  assert.notEqual(
    workspaceForManagedNode(".relay/managed-workspaces", "mnode_cloud_1"),
    workspaceForManagedNode(".relay/managed-workspaces", "mnode_cloud_2"),
  );
});

test("supervisor skips online nodes and does not assume a BoxLite provider", async () => {
  const backend = new FakeBackend(
    [{ id: "alice" }, { id: "bob" }],
    [
      node({ id: "sbx_alice", userId: "alice", status: "ready", online: true, stale: false, nodeToken: "tok_alice" }),
      node({ id: "sbx_bob", userId: "bob", status: "stopped", online: false, stale: true, nodeToken: "tok_bob" }),
    ],
  );
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForUser: (user) => `/remote/${user.id}`,
  });

  const result = await supervisor.reconcileOnce();

  assert.equal(result.started, 1);
  assert.equal(result.skipped, 1);
  assert.equal(launcher.starts[0].user.id, "bob");
  assert.equal(launcher.starts[0].workspacePath, "/remote/bob");
});

test("supervisor restarts a managed daemon after its child exits", async () => {
  const backend = new FakeBackend(
    [{ id: "alice" }],
    [node({ id: "sbx_alice", userId: "alice", status: "stopped", online: false, stale: true, nodeToken: "tok_alice" })],
  );
  const launcher = new ExitedChildLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForUser: (user) => `/workspaces/${user.id}`,
  });

  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal(launcher.starts.length, 2);
});

test("supervisor backend requests time out instead of freezing reconciliation", async () => {
  const client = new SupervisorBackendClient({
    backendUrl: "http://backend.test",
    requestTimeoutMs: 5,
    fetchFn: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  } as ConstructorParameters<typeof SupervisorBackendClient>[0] & { requestTimeoutMs: number });

  await assert.rejects(client.listManagedNodes(), /timeout|aborted/i);
});

test("supervisor recovers offline nodes without tokens in HTTP list responses", async () => {
  const backend = new FakeBackend([{ id: "alice" }], [node({ id: "sbx_alice", userId: "alice" })]);
  const provision = backend.provisionDaemonNode.bind(backend);
  backend.provisionDaemonNode = async (input) => {
    const response = await provision(input);
    return { ...response, daemonEnv: { ...response.daemonEnv, RELAY_DAEMON_NODE_TOKEN: "recovered-token" } };
  };
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({ backend, launcher, workspacePathForUser: () => "/workspace" });
  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal(backend.provisionCalls.length, 1);
  assert.equal(launcher.starts[0].env.RELAY_DAEMON_NODE_TOKEN, "recovered-token");
});

test("remote bootstrap exit does not replace HTTP registration during its grace period", async () => {
  const backend = new FakeBackend([{ id: "alice" }], []);
  const launcher = new ExitedChildLauncher();
  Object.defineProperty(launcher, "connectionMode", { value: "http" });
  const supervisor = new RelaySupervisor({ backend, launcher, workspacePathForUser: () => "/workspace" });
  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal((await supervisor.reconcileOnce()).started, 0);
  assert.equal(launcher.starts.length, 1);
});

test("remote recovery follows HTTP liveness after bootstrap and detaches on shutdown", async () => {
  const runtime = node({ id: "sbx_alice", userId: "alice", nodeToken: "token" });
  const backend = new FakeBackend([{ id: "alice" }], [runtime]);
  let starts = 0;
  let stops = 0;
  let clock = 0;
  const launcher: DaemonLauncher = {
    name: "cloud", connectionMode: "http",
    async start() { starts++; return { key: "remote", provider: "cloud", async stop() { stops++; } }; },
  };
  const supervisor = new RelaySupervisor({ backend, launcher, now: () => clock,
    registrationTimeoutMs: 1000, workspacePathForUser: () => "/workspace" });
  await supervisor.reconcileOnce();
  clock = 999;
  await supervisor.reconcileOnce();
  assert.equal(starts, 1);
  clock = 1000;
  await supervisor.reconcileOnce();
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  runtime.online = true;
  runtime.stale = false;
  await supervisor.reconcileOnce();
  runtime.online = false;
  runtime.stale = true;
  await supervisor.reconcileOnce();
  assert.equal(starts, 3);
  await supervisor.stop();
  assert.equal(stops, 1);
});

test("local launcher rejects spawn failures without crashing the supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-launch-error-"));
  try {
    const launcher = new LocalDaemonLauncher({ backendUrl: "http://backend.test", workspaceRoot: root,
      command: join(root, "missing-daemon") });
    await assert.rejects(launcher.start({ user: { id: "alice" },
      node: node({ id: "sbx_alice", userId: "alice" }), workspacePath: root,
      env: { RELAY_DAEMON_NODE_TOKEN: "token" } }), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local launcher refuses host execution before spawning without acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-host-ack-"));
  const previous = process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION;
  delete process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION;
  try {
    const launcher = new LocalDaemonLauncher({ backendUrl: "http://backend.test", workspaceRoot: root,
      sandboxMode: "none", command: "/usr/bin/true" });
    await assert.rejects(launcher.start({ user: { id: "alice" },
      node: node({ id: "sbx_alice", userId: "alice" }), workspacePath: root,
      env: { RELAY_DAEMON_NODE_TOKEN: "token" } }), /Host agent execution/);
  } finally {
    if (previous === undefined) delete process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION;
    else process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledged local host execution forwards permission to the daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-host-launch-"));
  try {
    const launcher = new LocalDaemonLauncher({ backendUrl: "http://backend.test", workspaceRoot: root,
      sandboxMode: "none", allowHostAgentExecution: true, command: "/usr/bin/true" });
    const managed = await launcher.start({ user: { id: "alice" },
      node: node({ id: "sbx_alice", userId: "alice" }), workspacePath: root,
      env: { RELAY_DAEMON_NODE_TOKEN: "token" } });
    assert.ok(managed.child?.spawnargs.includes("--allow-host-agent-execution"));
    await managed.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("remote command launcher rejects a missing bootstrap directory safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-bootstrap-error-"));
  try {
    const launcher = new CommandTemplateLauncher({ command: "true", cwd: join(root, "missing") });
    await assert.rejects(launcher.start({ user: { id: "alice" },
      node: node({ id: "sbx_alice", userId: "alice" }), workspacePath: root,
      env: { RELAY_DAEMON_NODE_TOKEN: "token" } }), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function workspaceRootFs(paths: string[], fail: { rename?: boolean; symlink?: boolean } = {}) {
  const dirs = new Set(paths);
  const links = new Map<string, string>();
  const calls: string[] = [];
  const fs: WorkspaceRootFs = {
    exists: (path) => dirs.has(path) || links.has(path),
    isSymlink: (path) => links.has(path),
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`);
      if (fail.rename) throw new Error("EXDEV");
      dirs.delete(from);
      dirs.add(to);
    },
    symlink: (target, path) => {
      calls.push(`symlink ${target} ${path}`);
      if (fail.symlink) throw new Error("EPERM");
      links.set(path, target);
    },
  };
  return { fs, calls, dirs, links };
}

test("supervisor defaults managed workspaces to .relay-workspaces", () => {
  const fresh = workspaceRootFs([]);
  assert.equal(defaultWorkspaceRoot(fresh.fs), ".relay-workspaces");
  assert.deepEqual(fresh.calls, []);

  const current = workspaceRootFs([".relay-workspaces", ".relay/employee-workspaces"]);
  assert.equal(defaultWorkspaceRoot(current.fs), ".relay-workspaces");
  assert.deepEqual(current.calls, []);
});

test("supervisor moves an older workspace root and links the old path to it", () => {
  for (const legacy of [".relay/employee-workspaces", ".relay/user-workspaces"]) {
    const { fs, calls, dirs, links } = workspaceRootFs([legacy]);
    assert.equal(defaultWorkspaceRoot(fs), ".relay-workspaces");
    assert.deepEqual(calls, [`rename ${legacy} .relay-workspaces`, `symlink ../.relay-workspaces ${legacy}`]);
    assert.ok(dirs.has(".relay-workspaces"));
    assert.equal(links.get(legacy), "../.relay-workspaces");
  }
  const both = workspaceRootFs([".relay/employee-workspaces", ".relay/user-workspaces"]);
  defaultWorkspaceRoot(both.fs);
  assert.equal(both.calls[0], "rename .relay/user-workspaces .relay-workspaces");
});

test("supervisor keeps the older workspace root when the move cannot finish", () => {
  const renameFails = workspaceRootFs([".relay/employee-workspaces"], { rename: true });
  assert.equal(defaultWorkspaceRoot(renameFails.fs), ".relay/employee-workspaces");

  const linkFails = workspaceRootFs([".relay/employee-workspaces"], { symlink: true });
  assert.equal(defaultWorkspaceRoot(linkFails.fs), ".relay/employee-workspaces");
  assert.ok(linkFails.dirs.has(".relay/employee-workspaces"));
  assert.ok(!linkFails.dirs.has(".relay-workspaces"));
});
