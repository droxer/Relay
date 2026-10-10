import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computerCanSelectModel, computerName, computerReportedModels, computerUsesCustomModelEndpoint, runtimesForComputer, computersForEmployee } from "../src/lib/createAgent.js";

describe("create agent options", () => {
  it("shows the computer name and never substitutes its workspace path", () => {
    const named = { id: "node-1", displayName: "Build Cloud", workspacePath: "/workspace/build" };
    const unnamed = { id: "node-2", workspacePath: "/Users/alice/private-project" };

    assert.equal(computerName(named), "Build Cloud");
    assert.equal(computerName(unnamed), "node-2");
  });

  it("lists each computer once even when it has several runtime nodes", () => {
    const nodes = [
      { id: "n1", employeeId: "alice", workspaceId: "m1", supportedAgents: ["claude"] },
      { id: "n2", employeeId: "alice", workspaceId: "m1", supportedAgents: ["codex"] },
    ];
    const computers = computersForEmployee(nodes, "alice");
    assert.equal(computers.length, 1);
  });

  it("offers both local and cloud computers assigned to the employee", () => {
    const nodes = [
      { id: "local", employeeId: "alice", workspaceId: "mac", supportedAgents: ["claude"] },
      { id: "cloud", employeeId: "alice", managedNodeId: "cloud-1", supportedAgents: ["codex"] },
    ];

    assert.deepEqual(
      computersForEmployee(nodes, "alice").map(({ computerId, ownership }) => ({ computerId, ownership })),
      [
        { computerId: "device:alice:mac", ownership: "local" },
        { computerId: "managed:cloud-1", ownership: "managed" },
      ],
    );
  });

  it("unions runtimes across a computer's nodes and drops disabled ones", () => {
    const nodes = [
      { id: "n1", employeeId: "alice", workspaceId: "m1", supportedAgents: ["claude"] },
      {
        id: "n2",
        employeeId: "alice",
        workspaceId: "m1",
        supportedAgents: ["codex", "pi"],
        disabledAgents: ["pi"],
      },
    ];
    assert.deepEqual(
      runtimesForComputer(nodes, "device:alice:m1").sort(),
      ["claude", "codex"],
    );
  });

  it("excludes another employee's computers", () => {
    const nodes = [
      { id: "n1", employeeId: "bob", workspaceId: "m1", supportedAgents: ["claude"] },
    ];
    assert.deepEqual(computersForEmployee(nodes, "alice"), []);
  });
});

describe("model selection on a computer", () => {
  const live = { employeeId: "alice", workspaceId: "mac", supportedAgents: ["claude"], status: "ready" };

  it("allows a model only when the live daemon running the runtime can pass it on", () => {
    const target = "device:alice:mac";
    assert.equal(computerCanSelectModel([{ ...live, id: "n1", capabilities: ["agent-model"] }], target, "claude"), true);
    assert.equal(computerCanSelectModel([{ ...live, id: "n1", capabilities: [] }], target, "claude"), false);
  });

  it("ignores stale node records and nodes that do not run the runtime", () => {
    const target = "device:alice:mac";
    const nodes = [
      { ...live, id: "new", capabilities: ["agent-model"] },
      { ...live, id: "old", status: "stopped", capabilities: [] },
      { ...live, id: "other", supportedAgents: ["codex"], capabilities: [] },
    ];
    assert.equal(computerCanSelectModel(nodes, target, "claude"), true);
  });

  it("does not block when no live node is known", () => {
    assert.equal(computerCanSelectModel([{ ...live, id: "n1", status: "stopped" }], "device:alice:mac", "claude"), true);
  });

  it("flags a runtime its live node routes to a custom model endpoint", () => {
    const target = "device:alice:mac";
    const proxied = { ...live, id: "n1", customModelEndpoints: ["claude"] };
    assert.equal(computerUsesCustomModelEndpoint([proxied], target, "claude"), true);
    assert.equal(computerUsesCustomModelEndpoint([proxied], target, "codex"), false);
    assert.equal(computerUsesCustomModelEndpoint([{ ...proxied, status: "stopped" }], target, "claude"), false);
    assert.equal(computerUsesCustomModelEndpoint([{ ...live, id: "n1" }], target, "claude"), false);
  });

  it("offers the models a runtime reports on the computer's live nodes, merged in order", () => {
    const target = "device:alice:mac";
    const nodes = [
      { ...live, id: "a", agentModels: { codex: ["gpt-6-luna", "gpt-5.6-terra"], claude: ["opus"] } },
      { ...live, id: "b", agentModels: { codex: ["gpt-5.6-terra", "gpt-5.6-luna"] } },
      { ...live, id: "old", status: "stopped", agentModels: { codex: ["gpt-retired"] } },
    ];
    assert.deepEqual(computerReportedModels(nodes, target, "codex"), ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"]);
    assert.deepEqual(computerReportedModels(nodes, target, "pi"), []);
    assert.deepEqual(computerReportedModels(nodes, "device:bob:pc", "codex"), []);
  });
});
