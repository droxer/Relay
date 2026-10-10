/**
 * Pure option-derivation helpers for the create-agent form: grouping a
 * employee's daemon nodes into computers, and listing the runtimes actually
 * available on a given computer.
 */

export interface NodeLike {
  id: string;
  employeeId?: string;
  workspaceId?: string;
  managedNodeId?: string;
  supportedAgents?: string[];
  disabledAgents?: string[];
  /** Daemon capabilities, e.g. "agent-model". */
  capabilities?: readonly string[];
  /** Runtimes whose model calls go to a custom endpoint on this node. */
  customModelEndpoints?: readonly string[];
  /** Model ids each runtime itself reports on this node. */
  agentModels?: Readonly<Record<string, readonly string[] | undefined>>;
  status?: string;
}

const LIVE_NODE_STATUSES = new Set(["ready", "busy"]);

export type ComputerOwnership = "local" | "managed";

/** A workspace path is execution metadata, never a user-facing Computer name. */
export function computerName(node: { id: string; displayName?: string }): string {
  return node.displayName?.trim() || node.id;
}

/** Mirrors the backend's core/computer_identity.py computer_id() one-to-one. */
export function computerId(node: NodeLike): string {
  const managed = node.managedNodeId?.trim();
  if (managed) return `managed:${managed}`;
  const employee = node.employeeId?.trim();
  const machine = node.workspaceId?.trim();
  if (employee && machine) return `device:${employee}:${machine}`;
  return `node:${node.id}`;
}

export function computersForEmployee(
  nodes: NodeLike[],
  employeeId: string,
): { computerId: string; ownership: ComputerOwnership; nodes: NodeLike[] }[] {
  const byComputer = new Map<string, NodeLike[]>();
  for (const node of nodes) {
    if (node.employeeId !== employeeId) continue;
    const id = computerId(node);
    byComputer.set(id, [...(byComputer.get(id) ?? []), node]);
  }
  return [...byComputer].map(([id, group]) => ({
    computerId: id,
    ownership: group.some((node) => Boolean(node.managedNodeId?.trim())) ? "managed" : "local",
    nodes: group,
  }));
}

export function runtimesForComputer(nodes: NodeLike[], target: string): string[] {
  const supported = new Set<string>();
  const disabled = new Set<string>();
  for (const node of nodes) {
    if (computerId(node) !== target) continue;
    for (const kind of node.supportedAgents ?? []) supported.add(kind);
    for (const kind of node.disabledAgents ?? []) disabled.add(kind);
  }
  return [...supported].filter((kind) => !disabled.has(kind));
}

/**
 * Whether a model picked for `kind` on this computer would reach the runtime.
 * Only live nodes running that runtime count: a stale record left behind by
 * re-provisioning says nothing about the daemon that will take the run. With
 * no live node it answers true — nothing is known, and the backend's dispatch
 * gate still refuses an outdated daemon.
 */
export function computerCanSelectModel(nodes: NodeLike[], target: string, kind: string): boolean {
  const runners = nodes.filter((node) => computerId(node) === target
    && LIVE_NODE_STATUSES.has(node.status ?? "")
    && (node.supportedAgents ?? []).includes(kind)
    && !(node.disabledAgents ?? []).includes(kind));
  return runners.every((node) => node.capabilities?.includes("agent-model"));
}

/**
 * Whether `kind` on this computer calls a custom model endpoint (a proxy or a
 * compatible provider) whose reported models may be the vendor's ids, which
 * may not exist there. A daemon with `endpoint-models` reports only what the
 * endpoint itself lists, so its options are offered as is.
 */
export function computerUsesCustomModelEndpoint(nodes: NodeLike[], target: string, kind: string): boolean {
  return nodes.some((node) => computerId(node) === target
    && LIVE_NODE_STATUSES.has(node.status ?? "")
    && (node.customModelEndpoints ?? []).includes(kind)
    && !node.capabilities?.includes("endpoint-models"));
}

/**
 * The models `kind` itself reports on this computer, in the runtime's order,
 * merged across the computer's live nodes.
 */
export function computerReportedModels(nodes: NodeLike[], target: string, kind: string): string[] {
  const models = new Set<string>();
  for (const node of nodes) {
    if (computerId(node) !== target || !LIVE_NODE_STATUSES.has(node.status ?? "")) continue;
    for (const model of node.agentModels?.[kind] ?? []) models.add(model);
  }
  return [...models];
}
