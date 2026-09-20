import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/cli.js";
import { assertHostAgentExecutionAllowed } from "../src/index.js";

test("relay-daemon CLI parses admin-created credential flags", () => {
  const args = parseArgs([
    "node",
    "relay-daemon",
    "--backend-url",
    "http://127.0.0.1:8790",
    "--sandbox-id",
    "sbx_alice_123",
    "--employee-id",
    "alice",
    "--token",
    "tok_node",
    "--workspace",
    "/Users/alice/project",
    "--workspace-id",
    "repo:relay",
    "--sandbox",
    "none",
    "--use-local-agent-home",
    "--allow-host-agent-execution",
  ]);

  assert.deepEqual(args, {
    backendUrl: "http://127.0.0.1:8790",
    sandboxId: "sbx_alice_123",
    employeeId: "alice",
    token: "tok_node",
    workspace: "/Users/alice/project",
    workspaceId: "repo:relay",
    sandbox: "none",
    useLocalAgentHome: true,
    allowHostAgentExecution: true,
    doctor: false,
    help: false,
    version: false,
  });
});

test("relay-daemon CLI still allows env-only runtime options", () => {
  const args = parseArgs(["node", "relay-daemon"]);

  assert.deepEqual(args, {
    backendUrl: undefined,
    sandboxId: undefined,
    employeeId: undefined,
    token: undefined,
    workspace: undefined,
    workspaceId: undefined,
    sandbox: undefined,
    useLocalAgentHome: false,
    allowHostAgentExecution: false,
    doctor: false,
    help: false,
    version: false,
  });
});

test("relay-daemon CLI parses doctor mode", () => {
  const args = parseArgs(["node", "relay-daemon", "--doctor", "--sandbox-id", "sbx_alice"]);

  assert.deepEqual(args, {
    backendUrl: undefined,
    sandboxId: "sbx_alice",
    employeeId: undefined,
    token: undefined,
    workspace: undefined,
    workspaceId: undefined,
    sandbox: undefined,
    useLocalAgentHome: false,
    allowHostAgentExecution: false,
    doctor: true,
    help: false,
    version: false,
  });
});

test("host agent execution requires an explicit high-risk opt-in", () => {
  assert.throws(
    () => assertHostAgentExecutionAllowed("none", false),
    /allow-host-agent-execution/,
  );
  assert.doesNotThrow(() => assertHostAgentExecutionAllowed("none", true));
  assert.doesNotThrow(() => assertHostAgentExecutionAllowed("boxlite", false));
});


test("local permission policy is explicit and rejects invalid values", () => {
  assert.equal(parseArgs(["node", "relay-daemon", "--local-permission-policy", "trusted"]).localPermissionPolicy, "trusted");
  assert.equal(parseArgs(["node", "relay-daemon", "--runtime-profile", "/private/runtime.json"]).runtimeProfile, "/private/runtime.json");
  assert.throws(() => parseArgs(["node", "relay-daemon", "--local-permission-policy", "typo"]), /policy/);
  assert.throws(() => parseArgs(["node", "relay-daemon", "--runtime-profile"]), /path/);
});
