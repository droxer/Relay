import test from "node:test";
import assert from "node:assert/strict";
import { FlyMachinesProvider, flyMachinesConfigFromEnv, type FlyMachinesConfig } from "../src/fly-machines.js";
import type { EnsureManagedNodeInput, ManagedNodeRecord } from "../src/types.js";

const CONFIG: FlyMachinesConfig = {
  apiToken: "fly-secret-token",
  app: "relay-computers",
  image: "registry.fly.io/relay-computers:v1",
  region: "iad",
  cpuKind: "shared",
  cpus: 2,
  memoryMb: 4096,
  volumeSizeGb: 20,
};

interface FakeMachine {
  id: string;
  name: string;
  region: string;
  state: string;
  config: Record<string, any>;
}

interface FakeVolume {
  id: string;
  name: string;
  state: string;
  attached_machine_id: string | null;
}

/** An in-memory stand-in for the Machines API: just the routes the provider uses. */
class FakeFly {
  machines = new Map<string, FakeMachine>();
  volumes = new Map<string, FakeVolume>();
  calls: string[] = [];
  failMachineCreate = false;
  private nextId = 1;

  readonly fetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(`/v1/apps/${CONFIG.app}`, "");
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${CONFIG.apiToken}`);
    this.calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return this.route(method, path, body);
  };

  private route(method: string, path: string, body: any): Response {
    if (method === "GET" && path === "/machines") {
      return json([...this.machines.values()].filter((machine) => machine.state !== "destroyed"));
    }
    if (method === "POST" && path === "/machines") {
      if (this.failMachineCreate) return new Response("no capacity in region", { status: 422 });
      const id = `m${this.nextId++}`;
      const machine = { id, name: body.name, region: body.region, state: "started", config: body.config };
      this.machines.set(id, machine);
      this.attach(machine);
      return json(machine);
    }
    if (method === "GET" && path === "/volumes") return json([...this.volumes.values()]);
    if (method === "POST" && path === "/volumes") {
      const volume = { id: `vol_${this.nextId++}`, name: body.name, state: "created", attached_machine_id: null };
      this.volumes.set(volume.id, volume);
      return json(volume);
    }
    const volumeMatch = path.match(/^\/volumes\/([^/]+)$/);
    if (volumeMatch && method === "DELETE") {
      const volume = this.volumes.get(volumeMatch[1]);
      if (!volume) return notFound();
      if (volume.attached_machine_id) return new Response("volume is attached", { status: 412 });
      this.volumes.delete(volume.id);
      return json(volume);
    }
    const machineMatch = path.match(/^\/machines\/([^/]+)(?:\/(start|stop))?$/);
    const machine = machineMatch ? this.machines.get(machineMatch[1]) : undefined;
    if (!machineMatch || !machine || machine.state === "destroyed") return notFound();
    const action = machineMatch[2];
    if (method === "GET" && !action) {
      // Stopping is asynchronous: the first read after a stop still sees it.
      const observed = json(machine);
      if (machine.state === "stopping") machine.state = "stopped";
      return observed;
    }
    if (method === "POST" && !action) {
      machine.config = body.config;
      machine.state = "started";
      return json(machine);
    }
    if (method === "POST" && action === "start") {
      if (machine.state === "started") return new Response("already started", { status: 412 });
      machine.state = "started";
      return json({ ok: true });
    }
    if (method === "POST" && action === "stop") {
      if (machine.state === "stopped") return new Response("already stopped", { status: 412 });
      machine.state = "stopping";
      return json({ ok: true });
    }
    if (method === "DELETE" && !action) {
      machine.state = "destroyed";
      for (const volume of this.volumes.values()) {
        if (volume.attached_machine_id === machine.id) volume.attached_machine_id = null;
      }
      return json({ ok: true });
    }
    return new Response("unexpected route", { status: 500 });
  }

  private attach(machine: FakeMachine): void {
    for (const mount of machine.config.mounts ?? []) {
      const volume = this.volumes.get(mount.volume);
      if (volume) volume.attached_machine_id = machine.id;
    }
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

function managedNode(overrides: Partial<ManagedNodeRecord> = {}): ManagedNodeRecord {
  return {
    id: "6f1c2a9e-0b7d-4c55-9a3e-2d8f61c0b4a7",
    displayName: "Alice cloud",
    userId: "alice",
    assignmentMode: "dedicated",
    provider: "fly-machines",
    profile: "standard",
    sandboxMode: "none",
    workspacePolicy: { kind: "user-home" },
    desiredState: "running",
    generation: 1,
    phase: "requested",
    conditions: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

function ensureInput(attemptId: string, overrides: Partial<ManagedNodeRecord> = {}): EnsureManagedNodeInput {
  const node = managedNode(overrides);
  return {
    node,
    attempt: {
      id: attemptId,
      managedNodeId: node.id,
      generation: node.generation,
      attemptNumber: 1,
      status: "allocating",
      startedAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    },
    backendUrl: "https://relay.example.com",
    enrollmentCredential: `grant-${attemptId}.secret`,
    workspacePath: "/ignored/on/fly",
    workspaceId: `managed-node:${node.id}:workspace-root`,
  };
}

function provider(fly: FakeFly): FlyMachinesProvider {
  return new FlyMachinesProvider({ config: CONFIG, fetch: fly.fetch, sleep: async () => undefined });
}

test("ensure creates a volume and a machine that enrolls the daemon from it", async () => {
  const fly = new FakeFly();

  const instance = await provider(fly).ensure(ensureInput("attempt-1"));

  const [volume] = fly.volumes.values();
  const [machine] = fly.machines.values();
  assert.equal(instance.id, `${machine.id}:${volume.id}`);
  assert.match(volume.name, /^relay_[a-z0-9]{24}$/);
  assert.equal(machine.region, "iad");
  assert.equal(machine.config.image, CONFIG.image);
  assert.deepEqual(machine.config.mounts, [{ volume: volume.id, path: "/data" }]);
  assert.deepEqual(machine.config.guest, { cpu_kind: "shared", cpus: 2, memory_mb: 4096 });
  assert.equal(machine.config.env.RELAY_ENROLLMENT_TOKEN, "grant-attempt-1.secret");
  assert.equal(machine.config.env.RELAY_BACKEND_URL, "https://relay.example.com");
  assert.equal(machine.config.env.RELAY_SANDBOX_MODE, "none");
  assert.equal(machine.config.env.RELAY_ALLOW_HOST_AGENT_EXECUTION, "1");
  assert.equal(machine.config.env.RELAY_WORKSPACE, "/data/workspace");
  assert.equal(machine.config.env.HOME, "/data/home");
  assert.equal(machine.config.metadata.relay_managed_node, managedNode().id);
  assert.equal(machine.config.metadata.relay_attempt, "attempt-1");
  assert.deepEqual(machine.config.stop_config, { signal: "SIGTERM", timeout: "30s" });
});

test("ensure refuses a BoxLite node, because a Fly machine has no /dev/kvm", async () => {
  const fly = new FakeFly();

  await assert.rejects(provider(fly).ensure(ensureInput("attempt-1", { sandboxMode: "boxlite" })), /sandboxMode none/);
  assert.deepEqual(fly.calls, []);
});

test("ensure is idempotent for the attempt it already launched", async () => {
  const fly = new FakeFly();
  const first = await provider(fly).ensure(ensureInput("attempt-1"));

  const second = await provider(fly).ensure(ensureInput("attempt-1"));

  assert.equal(second.id, first.id);
  assert.equal(fly.machines.size, 1);
  assert.equal(fly.volumes.size, 1);
  assert.equal(fly.calls.filter((call) => call.startsWith("POST /machines")).length, 1);
});

test("a new attempt reuses the machine and its volume and restarts it with the new grant", async () => {
  const fly = new FakeFly();
  const first = await provider(fly).ensure(ensureInput("attempt-1"));
  await provider(fly).stop(first.id);

  const second = await provider(fly).ensure(ensureInput("attempt-2", { generation: 2 }));

  assert.equal(second.id, first.id);
  const [machine] = fly.machines.values();
  assert.equal(machine.state, "started");
  assert.equal(machine.config.env.RELAY_ENROLLMENT_TOKEN, "grant-attempt-2.secret");
  assert.equal(machine.config.metadata.relay_generation, "2");
  assert.equal(fly.volumes.size, 1);
});

test("a suspended machine is cold-stopped before taking a new grant", async () => {
  const fly = new FakeFly();
  await provider(fly).ensure(ensureInput("attempt-1"));
  const [machine] = fly.machines.values();
  machine.state = "suspended";

  await provider(fly).ensure(ensureInput("attempt-2"));

  assert.ok(fly.calls.includes(`POST /machines/${machine.id}/stop`));
  assert.equal(machine.state, "started");
  assert.equal(machine.config.env.RELAY_ENROLLMENT_TOKEN, "grant-attempt-2.secret");
});

test("a failed machine create discards the volume it just made", async () => {
  const fly = new FakeFly();
  fly.failMachineCreate = true;

  await assert.rejects(provider(fly).ensure(ensureInput("attempt-1")), /422/);

  assert.equal(fly.volumes.size, 0);
});

test("stop returns only once the machine has actually stopped", async () => {
  const fly = new FakeFly();
  const instance = await provider(fly).ensure(ensureInput("attempt-1"));

  await provider(fly).stop(instance.id);

  const [machine] = fly.machines.values();
  assert.equal(machine.state, "stopped");
});

test("ensure waits out a stop in progress before updating the machine", async () => {
  const fly = new FakeFly();
  await provider(fly).ensure(ensureInput("attempt-1"));
  const [machine] = fly.machines.values();
  machine.state = "stopping";

  await provider(fly).ensure(ensureInput("attempt-2"));

  assert.equal(machine.state, "started");
  assert.equal(machine.config.env.RELAY_ENROLLMENT_TOKEN, "grant-attempt-2.secret");
});

test("inspect reports a running machine and treats a missing one as stopped", async () => {
  const fly = new FakeFly();
  const instance = await provider(fly).ensure(ensureInput("attempt-1"));

  assert.equal(await provider(fly).inspect(instance.id), "running");
  await provider(fly).stop(instance.id);
  assert.equal(await provider(fly).inspect(instance.id), "stopped");
  assert.equal(await provider(fly).inspect("gone:vol_gone"), "stopped");
});

test("stop tolerates a machine that is already stopped or gone", async () => {
  const fly = new FakeFly();
  const instance = await provider(fly).ensure(ensureInput("attempt-1"));
  await provider(fly).stop(instance.id);

  await provider(fly).stop(instance.id);
  await provider(fly).stop("gone:vol_gone");
});

test("delete destroys the machine, then its volume, and a retry finishes the job", async () => {
  const fly = new FakeFly();
  const instance = await provider(fly).ensure(ensureInput("attempt-1"));

  await provider(fly).delete(instance.id);
  await provider(fly).delete(instance.id);

  assert.equal([...fly.machines.values()].filter((machine) => machine.state !== "destroyed").length, 0);
  assert.equal(fly.volumes.size, 0);
});

test("API failures name the call and status but never the token", async () => {
  const failing = async () => new Response("quota exceeded", { status: 422 });
  const fly = new FlyMachinesProvider({ config: CONFIG, fetch: failing, sleep: async () => undefined });

  await assert.rejects(fly.ensure(ensureInput("attempt-1")), (error: Error) => {
    assert.match(error.message, /422/);
    assert.doesNotMatch(error.message, /fly-secret-token/);
    return true;
  });
});

test("the provider is configured from the environment only when an app is named", () => {
  assert.equal(flyMachinesConfigFromEnv({}), undefined);
  assert.deepEqual(
    flyMachinesConfigFromEnv({
      RELAY_FLY_APP: "relay-computers",
      FLY_API_TOKEN: "token",
      RELAY_FLY_IMAGE: "registry.fly.io/relay-computers:v1",
      RELAY_FLY_REGION: "iad",
      RELAY_FLY_MEMORY_MB: "8192",
    }),
    {
      apiToken: "token",
      app: "relay-computers",
      image: "registry.fly.io/relay-computers:v1",
      region: "iad",
      cpuKind: "shared",
      cpus: 2,
      memoryMb: 8192,
      volumeSizeGb: 20,
    },
  );
  assert.throws(
    () => flyMachinesConfigFromEnv({ RELAY_FLY_APP: "relay-computers", RELAY_FLY_CPUS: "zero" }),
    (error: Error) => {
      for (const name of ["FLY_API_TOKEN", "RELAY_FLY_IMAGE", "RELAY_FLY_REGION", "RELAY_FLY_CPUS"]) {
        assert.match(error.message, new RegExp(name));
      }
      return true;
    },
  );
});
