import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assignControlPanelDaemonNode, createControlPanelDaemonNode, createControlPanelUser, createManagedNode, deleteManagedNode, listManagedNodes, permanentlyDeleteManagedNode } from "../src/api.js";
import { threadDaemonStatus } from "../src/lib/threadStatus.js";
import {
  mergeVisibleDaemonNodes,
  mergeThreadRuntimeNodes,
  withoutDeletedComputer,
  shouldClaimLocalDaemonNode,
} from "../src/lib/daemonNodes.js";
import {
  buildDaemonStartCommand,
  nodeOwnershipProfile,
  nodeSandboxProfile,
  nodeLocalityFlags,
  nodeLocalityKinds,
  resolveNodeCredentials,
  upsertStoredCredentialsFromNodes,
  visualStatus,
} from "../src/lib/adminHelpers.js";
import type {
  ControlPanelDaemonNodeRecord,
  DaemonNodeMonitorRecord,
} from "../src/types.js";

function daemonNode(input: Partial<DaemonNodeMonitorRecord> & { id: string; userId?: string }): DaemonNodeMonitorRecord {
  return {
    status: "ready",
    agents: { claude: "ready", pi: "ready", codex: "ready", kimi: "unknown" },
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    queuedCommandCount: 0,
    activeRuns: [],
    online: true,
    stale: false,
    ...input,
  };
}

function controlPanelNode(
  input: Partial<ControlPanelDaemonNodeRecord> & { id: string; userId?: string },
): ControlPanelDaemonNodeRecord {
  return {
    ...daemonNode(input),
    nodeToken: "node_token",
    ...input,
  };
}

describe("Relay web thread status", () => {
  it("shows a stale node as stale even when a daemon run is active", () => {
    const activeRun = {
      commandId: "cmd_1",
      sessionId: "ses_1",
      runId: "run_1",
      agent: "codex",
      taskGoal: "review daemon status",
      startedAt: "2026-06-12T00:00:00.000Z",
    } as const;

    assert.equal(threadDaemonStatus({
      node: {
        id: "sbx_alice",
        userId: "alice",
        status: "ready",
        agents: { claude: "ready", pi: "ready", codex: "ready", kimi: "unknown" },
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
        queuedCommandCount: 0,
        activeRuns: [activeRun],
        online: false,
        stale: true,
      },
      sandbox: { status: "provisioning" },
    }), "stale");
  });

  it("falls back to stale only when no daemon run is active", () => {
    assert.equal(threadDaemonStatus({
      node: {
        id: "sbx_alice",
        userId: "alice",
        status: "ready",
        agents: { claude: "ready", pi: "ready", codex: "ready", kimi: "unknown" },
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
        queuedCommandCount: 0,
        activeRuns: [],
        online: false,
        stale: true,
      },
      sandbox: { status: "ready" },
    }), "stale");
  });

  it("prefers a live local control-panel node over a stale authenticated node", () => {
    const staleAuthenticatedNode = daemonNode({
      id: "sbx_alice_old",
      userId: "alice",
      online: false,
      stale: true,
      lastSeenAt: "2026-06-12T00:00:00.000Z",
    });
    const liveControlPanelNode = controlPanelNode({
      id: "sbx_alice_live",
      userId: "alice",
      online: true,
      stale: false,
      lastSeenAt: "2026-06-12T00:00:03.000Z",
      agentDetails: { kimi: { detail: "Kimi is not logged in.", adapter: "cli" } },
    });

    const [visibleNode] = mergeVisibleDaemonNodes([staleAuthenticatedNode], [liveControlPanelNode]);

    assert.equal(visibleNode.id, "sbx_alice_live");
    assert.equal(visibleNode.online, true);
    assert.equal(visibleNode.agentDetails?.kimi?.detail, "Kimi is not logged in.");
    assert.equal(threadDaemonStatus({ node: visibleNode }), "ready");
    assert.equal("nodeToken" in visibleNode, false);
  });

  it("claims an online local node when the saved token only exposes stale nodes", () => {
    const staleAuthenticatedNode = daemonNode({
      id: "sbx_alice_old",
      userId: "alice",
      online: false,
      stale: true,
    });
    const liveControlPanelNode = controlPanelNode({
      id: "sbx_alice_live",
      userId: "alice",
      online: true,
      stale: false,
    });

    assert.equal(shouldClaimLocalDaemonNode(liveControlPanelNode, [staleAuthenticatedNode]), true);
    assert.equal(shouldClaimLocalDaemonNode(liveControlPanelNode, [daemonNode({
      id: "sbx_alice_live",
      userId: "alice",
      online: true,
      stale: false,
    })]), false);
  });

  it("keeps unassigned control-panel nodes out of the chat roster", () => {
    const assignedNode = controlPanelNode({
      id: "sbx_alice",
      userId: "alice",
      online: true,
      stale: false,
    });
    const unassignedNode = controlPanelNode({
      id: "sbx_unassigned",
      online: true,
      stale: false,
    });

    const visibleNodes = mergeVisibleDaemonNodes([], [assignedNode, unassignedNode]);

    assert.deepEqual(visibleNodes.map((node) => node.id), ["sbx_alice"]);
    assert.equal(shouldClaimLocalDaemonNode(unassignedNode, []), false);
  });

  it("keeps distinct computers for one user in the thread runtime picker", () => {
    const first = daemonNode({ id: "node_a", userId: "alice" });
    const second = controlPanelNode({ id: "node_b", userId: "alice" });

    const runtimeNodes = mergeThreadRuntimeNodes([first], [second]);

    assert.deepEqual(runtimeNodes.map((node) => node.id), ["node_a", "node_b"]);
    assert.equal(runtimeNodes.every((node) => !("nodeToken" in node)), true);
  });

  it("evicts every cached runtime incarnation of a deleted cloud computer", () => {
    const cached = [
      daemonNode({ id: "runtime_old", userId: "alice", managedNodeId: "cloud_1" }),
      daemonNode({ id: "runtime_active", userId: "alice", managedNodeId: "cloud_1" }),
      daemonNode({ id: "runtime_keep", userId: "alice", managedNodeId: "cloud_2" }),
    ];

    const remaining = withoutDeletedComputer(cached, controlPanelNode({
      id: "runtime_active",
      userId: "alice",
      managedNodeId: "cloud_1",
    }));

    assert.deepEqual(remaining.map((node) => node.id), ["runtime_keep"]);
  });

  it("keeps the computer's display name when the authenticated record wins the merge", () => {
    const lastSeenAt = "2026-06-12T00:00:03.000Z";
    const authenticated = daemonNode({ id: "sbx_alice", userId: "alice", lastSeenAt });
    const controlPanel = controlPanelNode({
      id: "sbx_alice",
      userId: "alice",
      lastSeenAt,
      displayName: "Alice's MacBook",
    });

    const [tied] = mergeThreadRuntimeNodes([authenticated], [controlPanel]);
    assert.equal("displayName" in tied ? tied.displayName : undefined, "Alice's MacBook");

    const [fresherAuthenticated] = mergeThreadRuntimeNodes(
      [daemonNode({ id: "sbx_alice", userId: "alice", lastSeenAt: "2026-06-12T00:00:05.000Z" })],
      [controlPanel],
    );
    assert.equal("displayName" in fresherAuthenticated ? fresherAuthenticated.displayName : undefined, "Alice's MacBook");
    assert.equal(fresherAuthenticated.lastSeenAt, "2026-06-12T00:00:05.000Z");
  });

  it("posts user creation with the selected unassigned node", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        user: {
          id: "alice",
          displayName: "Alice",
          email: "alice@example.com",
        },
        account: {
          id: "usr_alice",
          username: "alice",
          role: "user",
          userId: "alice",
        },
        node: controlPanelNode({
          id: "sbx_unassigned",
          userId: "alice",
        }),
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await createControlPanelUser({
        userId: "alice",
        username: "alice",
        password: "userpass",
        nodeId: "sbx_unassigned",
        email: "alice@example.com",
        displayName: "Alice",
      });

      assert.equal(requestPath, "/api/v1/admin/users");
      assert.equal(requestInit?.method, "POST");
      assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        userId: "alice",
        username: "alice",
        password: "userpass",
        nodeId: "sbx_unassigned",
        email: "alice@example.com",
        displayName: "Alice",
      });
      assert.equal(result.node?.userId, "alice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts ownerless daemon node creation when no user is supplied", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        node: controlPanelNode({
          id: "sbx_node_1",
        }),
        nodeToken: "node_token",
        daemonEnv: {
          RELAY_SANDBOX_ID: "sbx_node_1",
        },
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await createControlPanelDaemonNode({
        displayName: "Lab computer",
        workspacePath: "/workspace/shared",
      });

      assert.equal(requestPath, "/api/v1/admin/daemon-nodes");
      assert.equal(requestInit?.method, "POST");
      assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        displayName: "Lab computer",
        workspacePath: "/workspace/shared",
      });
      assert.equal(result.node.userId, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts managed-node intent without requesting daemon credentials", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        node: {
          id: "mnode_alice",
          displayName: "Managed node for alice",
          userId: "alice",
          assignmentMode: "dedicated",
          provider: "local-process",
          profile: "standard",
          sandboxMode: "boxlite",
          workspacePolicy: { kind: "user-home" },
          desiredState: "running",
          generation: 1,
          phase: "requested",
          conditions: [],
          createdAt: "2026-07-10T00:00:00Z",
          updatedAt: "2026-07-10T00:00:00Z",
        },
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await createManagedNode({
        userId: "alice",
        displayName: "Alice cloud",
        sandboxMode: "boxlite",
      });

      assert.equal(requestPath, "/api/v1/admin/managed-nodes");
      assert.equal(requestInit?.method, "POST");
      assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        userId: "alice",
        displayName: "Alice cloud",
        assignmentMode: "dedicated",
        provider: "local-process",
        profile: "standard",
        sandboxMode: "boxlite",
        workspacePolicy: { kind: "user-home" },
        desiredState: "running",
      });
      assert.equal(result.node.phase, "requested");
      assert.equal("daemonCommand" in result, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deletes managed desired state through the managed-node endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ node: { id: "mnode_alice", desiredState: "deleted" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await deleteManagedNode("mnode_alice");
      assert.equal(requestPath, "/api/v1/admin/managed-nodes/mnode_alice");
      assert.equal(requestInit?.method, "DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists managed-node history through the control-panel endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestPath = String(input);
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await listManagedNodes();
      assert.equal(requestPath, "/api/v1/admin/managed-nodes");
      assert.deepEqual(result.nodes, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("permanently deletes a terminal managed-node record", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await permanentlyDeleteManagedNode("mnode_old");
      assert.equal(requestPath, "/api/v1/admin/managed-nodes/mnode_old/record");
      assert.equal(requestInit?.method, "DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts direct node assignment for an existing user", async () => {
    const originalFetch = globalThis.fetch;
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        user: {
          id: "alice",
          displayName: "Alice",
        },
        node: controlPanelNode({
          id: "node_unassigned",
          userId: "alice",
        }),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await assignControlPanelDaemonNode({
        userId: "alice",
        nodeId: "node_unassigned",
      });

      assert.equal(requestPath, "/api/v1/admin/daemon-nodes/node_unassigned/assignment");
      assert.equal(requestInit?.method, "PUT");
      assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        userId: "alice",
      });
      assert.equal(result.node.userId, "alice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Relay web admin node helpers", () => {
  it("keeps a provisioning placeholder's stored status so quick filters match the lifecycle", () => {
    const placeholder = controlPanelNode({
      id: "mnode_alice",
      userId: "alice",
      status: "provisioning",
      online: false,
      stale: false,
      provisioningPlaceholder: true,
    });
    assert.equal(visualStatus(placeholder), "provisioning");

    const stopped = controlPanelNode({
      id: "mnode_bob",
      userId: "bob",
      status: "stopped",
      online: false,
      stale: false,
      provisioningPlaceholder: true,
    });
    assert.equal(visualStatus(stopped), "stopped");
  });
  it("builds a daemon start command from cached node metadata", () => {
    const command = buildDaemonStartCommand({
      id: "sbx_alice",
      userId: "alice",
      workspacePath: "/workspace/alice",
      sandboxMode: "boxlite",
    }, "tok_secret", "http://127.0.0.1:8790");

    assert.match(command, /--sandbox-id sbx_alice/);
    assert.doesNotMatch(command, /tok_secret|--token/);
    assert.match(command, /--sandbox boxlite/);
    assert.doesNotMatch(command, /--use-local-agent-home/);
    assert.match(command, /--user-id alice/);
    assert.match(command, /--workspace /);
  });

  it("defaults missing sandbox mode to managed command reconstruction", () => {
    const command = buildDaemonStartCommand({
      id: "sbx_pending",
      userId: "alice",
      workspacePath: "/workspace/alice",
    }, "tok_secret", "http://127.0.0.1:8790");

    assert.match(command, /--sandbox boxlite/);
    assert.doesNotMatch(command, /--use-local-agent-home/);
  });

  it("adds local agent home only for local daemon commands", () => {
    const command = buildDaemonStartCommand({
      id: "sbx_local",
      userId: "alice",
      workspacePath: "/workspace/alice",
      sandboxMode: "none",
    }, "tok_secret", "http://127.0.0.1:8790");

    assert.match(command, /--sandbox none/);
    assert.match(command, /--allow-host-agent-execution/);
    assert.match(command, /--use-local-agent-home/);
  });

  it("resolves credentials from browser cache when the server no longer reveals tokens", () => {
    const node = {
      ...controlPanelNode({
        id: "sbx_alice",
        userId: "alice",
        online: true,
        stale: false,
      }),
      nodeToken: undefined,
    };
    const resolved = resolveNodeCredentials(node, {
      nodeToken: "tok_cached",
      savedAt: "2026-06-12T00:00:00.000Z",
    }, "http://127.0.0.1:8790");

    assert.equal(resolved.source, "cache");
    assert.equal(resolved.nodeToken, "tok_cached");
    assert.doesNotMatch(resolved.daemonCommand ?? "", /tok_cached|--token/);
  });

  it("keeps device location separate from sandbox isolation", () => {
    const node = controlPanelNode({
      id: "sbx_alice",
      userId: "alice",
      online: true,
      stale: false,
      sandboxMode: "none",
      nodeLocation: "managed",
      managedNodeId: "mnode_alice",
    });
    const flags = nodeLocalityFlags(node, {
      colocated: true,
      storedTokens: {
        sbx_alice: { nodeToken: "tok_cached", savedAt: "2026-06-12T00:00:00.000Z" },
      },
    });

    assert.equal(flags.hasCachedCredentials, true);
    assert.equal(flags.isColocatedLive, false);
    assert.equal(nodeOwnershipProfile(node), "managed");
    assert.deepEqual(nodeLocalityKinds(node, {
      colocated: true,
      storedTokens: { sbx_alice: { nodeToken: "tok_cached", savedAt: "2026-06-12T00:00:00.000Z" } },
    }), ["saved_here"]);
    assert.equal(nodeOwnershipProfile({ nodeLocation: "user-device", sandboxMode: "boxlite" }), "local");
    assert.equal(nodeOwnershipProfile({ nodeLocation: "managed", sandboxMode: "none" }), "managed");
    assert.equal(nodeOwnershipProfile({ sandboxMode: "none" }), "pending");
    assert.equal(nodeSandboxProfile({ sandboxMode: "boxlite" }), "boxlite");
    assert.equal(nodeSandboxProfile({ sandboxMode: "none" }), "host");
    assert.equal(nodeSandboxProfile({}), "pending");
  });

  it("persists ephemeral control-panel node tokens into the stored map", () => {
    const node = controlPanelNode({
      id: "sbx_alice",
      userId: "alice",
      nodeToken: "tok_live",
      workspacePath: "/workspace/alice",
    });
    const updated = upsertStoredCredentialsFromNodes({}, [node], "http://127.0.0.1:8790");

    assert.ok(updated);
    assert.equal(updated?.sbx_alice.nodeToken, "tok_live");
    assert.doesNotMatch(updated?.sbx_alice.daemonCommand ?? "", /tok_live|--token/);
    assert.match(updated?.sbx_alice.daemonCommand ?? "", /--sandbox boxlite/);
    assert.doesNotMatch(updated?.sbx_alice.daemonCommand ?? "", /--use-local-agent-home/);
  });
});
