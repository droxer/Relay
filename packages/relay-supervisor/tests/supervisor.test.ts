import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPanelDaemonNodeRecord } from "relay-core";
import { SupervisorBackendClient } from "../src/backend-client.js";
import { LocalDaemonLauncher, workspaceForEmployee, workspaceForManagedNode } from "../src/launchers.js";
import { RelaySupervisor } from "../src/reconcile.js";
import type {
  DaemonLaunchRequest,
  DaemonLauncher,
  EmployeeRecord,
  ManagedDaemon,
  ProvisionedDaemonNode,
  SupervisorBackend,
} from "../src/types.js";

function node(input: Partial<ControlPanelDaemonNodeRecord> & { id: string; employeeId: string }): ControlPanelDaemonNodeRecord {
  return {
    id: input.id,
    employeeId: input.employeeId,
    workspacePath: input.workspacePath,
    status: input.status ?? "provisioning",
    agents: input.agents ?? { claude: "unknown", pi: "unknown", codex: "unknown", kimi: "unknown" },
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
  provisionCalls: Array<{ employeeId: string; workspacePath?: string }> = [];

  constructor(
    private readonly employees: EmployeeRecord[],
    private readonly nodes: ControlPanelDaemonNodeRecord[],
  ) {}

  async listEmployees(): Promise<EmployeeRecord[]> {
    return this.employees;
  }

  async listDaemonNodes(): Promise<ControlPanelDaemonNodeRecord[]> {
    return this.nodes;
  }

  async provisionDaemonNode(input: { employeeId: string; workspacePath?: string }): Promise<ProvisionedDaemonNode> {
    this.provisionCalls.push(input);
    const existing = this.nodes.find((item) => item.employeeId === input.employeeId);
    const next = existing ?? node({
      id: `sbx_${input.employeeId}`,
      employeeId: input.employeeId,
      workspacePath: input.workspacePath,
      nodeToken: `tok_${input.employeeId}`,
    });
    if (!existing) this.nodes.push(next);
    return {
      node: next,
      nodeToken: next.nodeToken,
      daemonEnv: {
        RELAY_BACKEND_URL: "http://backend.test",
        RELAY_SANDBOX_ID: next.id,
        RELAY_EMPLOYEE_ID: input.employeeId,
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
      key: `${request.employee.id}:${request.node.id}`,
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
      key: `${request.employee.id}:${request.node.id}`,
      provider: this.name,
      child,
      async stop() {},
    };
  }
}

test("supervisor provisions and starts missing employee daemon nodes", async () => {
  const backend = new FakeBackend([{ id: "alice" }], []);
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForEmployee: (employee) => `/workspaces/${employee.id}`,
  });

  const result = await supervisor.reconcileOnce();

  assert.deepEqual(result, { employees: 1, provisioned: 1, started: 1, skipped: 0 });
  assert.deepEqual(backend.provisionCalls, [{ employeeId: "alice", workspacePath: "/workspaces/alice" }]);
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
      employee: { id: "alice" },
      node: node({ id: "sbx_alice", employeeId: "alice", nodeToken: "tok_alice" }),
      workspacePath: join(workspaceRoot, "alice"),
      env: { RELAY_DAEMON_NODE_TOKEN: "tok_alice" },
    });

    assert.ok(managed.child?.spawnargs.includes("boxlite"));
    await managed.stop();
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("managed employee workspaces are absolute when the configured root is relative", () => {
  assert.equal(workspaceForEmployee(".relay/employee-workspaces", "alice"), join(process.cwd(), ".relay/employee-workspaces/alice"));
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
      node({ id: "sbx_alice", employeeId: "alice", status: "ready", online: true, stale: false, nodeToken: "tok_alice" }),
      node({ id: "sbx_bob", employeeId: "bob", status: "stopped", online: false, stale: true, nodeToken: "tok_bob" }),
    ],
  );
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForEmployee: (employee) => `/remote/${employee.id}`,
  });

  const result = await supervisor.reconcileOnce();

  assert.equal(result.started, 1);
  assert.equal(result.skipped, 1);
  assert.equal(launcher.starts[0].employee.id, "bob");
  assert.equal(launcher.starts[0].workspacePath, "/remote/bob");
});

test("supervisor restarts a managed daemon after its child exits", async () => {
  const backend = new FakeBackend(
    [{ id: "alice" }],
    [node({ id: "sbx_alice", employeeId: "alice", status: "stopped", online: false, stale: true, nodeToken: "tok_alice" })],
  );
  const launcher = new ExitedChildLauncher();
  const supervisor = new RelaySupervisor({
    backend,
    launcher,
    workspacePathForEmployee: (employee) => `/workspaces/${employee.id}`,
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
  const backend = new FakeBackend([{ id: "alice" }], [node({ id: "sbx_alice", employeeId: "alice" })]);
  const provision = backend.provisionDaemonNode.bind(backend);
  backend.provisionDaemonNode = async (input) => {
    const response = await provision(input);
    return { ...response, daemonEnv: { ...response.daemonEnv, RELAY_DAEMON_NODE_TOKEN: "recovered-token" } };
  };
  const launcher = new FakeLauncher();
  const supervisor = new RelaySupervisor({ backend, launcher, workspacePathForEmployee: () => "/workspace" });
  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal(backend.provisionCalls.length, 1);
  assert.equal(launcher.starts[0].env.RELAY_DAEMON_NODE_TOKEN, "recovered-token");
});

test("remote bootstrap exit does not replace HTTP registration during its grace period", async () => {
  const backend = new FakeBackend([{ id: "alice" }], []);
  const launcher = new ExitedChildLauncher();
  Object.defineProperty(launcher, "connectionMode", { value: "http" });
  const supervisor = new RelaySupervisor({ backend, launcher, workspacePathForEmployee: () => "/workspace" });
  assert.equal((await supervisor.reconcileOnce()).started, 1);
  assert.equal((await supervisor.reconcileOnce()).started, 0);
  assert.equal(launcher.starts.length, 1);
});

test("remote recovery follows HTTP liveness after bootstrap and detaches on shutdown", async () => {
  const runtime = node({ id: "sbx_alice", employeeId: "alice", nodeToken: "token" });
  const backend = new FakeBackend([{ id: "alice" }], [runtime]);
  let starts = 0;
  let stops = 0;
  let clock = 0;
  const launcher: DaemonLauncher = {
    name: "cloud", connectionMode: "http",
    async start() { starts++; return { key: "remote", provider: "cloud", async stop() { stops++; } }; },
  };
  const supervisor = new RelaySupervisor({ backend, launcher, now: () => clock,
    registrationTimeoutMs: 1000, workspacePathForEmployee: () => "/workspace" });
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
