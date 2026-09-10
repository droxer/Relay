const [providerModuleUrl, daemonCommand, stateDirectory, workspacePath] = process.argv.slice(2);
const { LocalProcessProvider } = await import(providerModuleUrl);

const node = {
  id: "mnode_signal",
  displayName: "Signal test",
  assignmentMode: "shared",
  provider: "local-process",
  profile: "standard",
  sandboxMode: "none",
  workspacePolicy: { kind: "node-affine" },
  desiredState: "running",
  generation: 1,
  phase: "allocating",
  conditions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const attempt = {
  id: "attempt_signal",
  managedNodeId: node.id,
  generation: node.generation,
  attemptNumber: 1,
  status: "allocating",
  startedAt: node.createdAt,
  updatedAt: node.updatedAt,
};
const provider = new LocalProcessProvider({ command: daemonCommand, stateDirectory });
const instance = await provider.ensure({
  node,
  attempt,
  backendUrl: "http://backend.test",
  enrollmentCredential: "grant.signal",
  workspacePath,
  workspaceId: "managed-node:mnode_signal:workspace-root",
});

process.stdout.write(`${JSON.stringify({ instanceId: instance.id, pid: instance.child?.pid })}\n`);
setInterval(() => {}, 60_000);
