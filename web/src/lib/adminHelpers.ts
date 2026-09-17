import type { TFunction } from "i18next";
import { backendPublicOrigin } from "./apiOrigin.ts";
import { byNumber, byText, type SortColumn } from "./listSort.ts";
import type { AgentName, ControlPanelDaemonNodeRecord, EmployeeAgent, EmployeeRecord, LogicalAgentAvailability, Tone } from "../types.js";

export const ADMIN_AGENTS_KEY = ["admin", "agents"] as const;

/** Stable display order for node surfaces; implemented independently of API order. */
export function stableNodeOrder(
  nodes: readonly ControlPanelDaemonNodeRecord[],
): ControlPanelDaemonNodeRecord[] {
  const label = (node: ControlPanelDaemonNodeRecord) => node.displayName?.trim() || node.id;
  return [...nodes].sort((left, right) => (
    label(left).localeCompare(label(right), undefined, { sensitivity: "base", numeric: true })
    || left.id.localeCompare(right.id, undefined, { sensitivity: "base", numeric: true })
  ));
}

const DEFAULT_NODE_AGENT_NAMES: AgentName[] = ["claude", "codex", "kimi"];

/** Agent executors shown on admin node surfaces (Pi only when the daemon reports it). */
export function visibleNodeAgentNames(node: Pick<ControlPanelDaemonNodeRecord, "agents">): AgentName[] {
  const names: AgentName[] = [...DEFAULT_NODE_AGENT_NAMES];
  if (node.agents.pi && node.agents.pi !== "unknown") names.push("pi");
  return names;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// A daemon connects to the backend directly, never through the web host, so
// the copied start command must name the backend origin even when the UI is
// hosted separately.
export function defaultBackendUrl(): string {
  return backendPublicOrigin();
}

/** Mirror backend daemon_start_command so cached node tokens stay usable after restart. */
export function buildDaemonStartCommand(
  node: Pick<ControlPanelDaemonNodeRecord, "id" | "employeeId" | "workspacePath" | "sandboxMode">,
  _nodeToken: string,
  backendUrl = defaultBackendUrl(),
): string {
  const sandboxMode = node.sandboxMode === "none" ? "none" : "boxlite";
  const parts = [
    "relay-daemon",
    "--backend-url",
    backendUrl,
    "--sandbox-id",
    node.id,
    "--sandbox",
    sandboxMode,
  ];
  if (sandboxMode === "none") {
    parts.push("--allow-host-agent-execution", "--use-local-agent-home");
  }
  if (node.employeeId) parts.push("--employee-id", node.employeeId);
  if (node.workspacePath) parts.push("--workspace", node.workspacePath);
  return `read -rsp 'Relay node token: ' RELAY_DAEMON_NODE_TOKEN && echo && export RELAY_DAEMON_NODE_TOKEN && ${parts.map(shellQuote).join(" ")}`;
}

export const STALE_AFTER_MS = 15_000;
export interface StoredNodeToken {
  employeeId?: string;
  sandboxToken?: string;
  nodeToken?: string;
  daemonCommand?: string;
  savedAt: string;
}

export type StoredNodeTokenMap = Record<string, StoredNodeToken>;
let volatileNodeTokens: StoredNodeTokenMap = {};

export function isStale(node: ControlPanelDaemonNodeRecord): boolean {
  if (typeof node.stale === "boolean") return node.stale;
  if (!node.online) return true;
  if (!node.lastSeenAt) return true;
  return Date.now() - new Date(node.lastSeenAt).getTime() > STALE_AFTER_MS;
}

export function visualStatus(node: ControlPanelDaemonNodeRecord): string {
  return isStale(node) ? "stale" : node.status;
}

export type NodeQuickFilter = "all" | "ready" | "running" | "provisioning" | "failed" | "stopped" | "unassigned";

/** Match the fleet lifecycle slices while keeping an intentional stop distinct
 * from a lost heartbeat. Assignment remains an overlapping facet. */
export function matchesNodeQuickFilter(
  node: ControlPanelDaemonNodeRecord,
  filter: NodeQuickFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "unassigned") return !node.employeeId;
  const status = visualStatus(node);
  if (filter === "failed") return status === "failed" || status === "stale";
  // "Running" describes the Computer process, not only an actively executing
  // agent run. Healthy idle (ready) and busy Computers are running too.
  if (filter === "running") {
    return isNodeOnline(node)
      && (node.status === "ready" || node.status === "busy" || node.status === "running");
  }
  return status === filter;
}

/** A computer is "online" when its daemon is connected and its heartbeat is fresh. */
export function isNodeOnline(node: ControlPanelDaemonNodeRecord): boolean {
  return Boolean(node.online) && !isStale(node);
}

// Canonical semantics (lib/statusTone.ts): active work → info, queued/paused
// → warn, ready → good, failures/unreachable → bad, unknown → neutral.
export function statusTone(status: string): Tone {
  if (status === "ready") return "good";
  if (status === "running" || status === "busy" || status === "provisioning") return "info";
  if (status === "pending" || status === "stopped") return "warn";
  if (status === "failed" || status === "stale") return "bad";
  return "neutral";
}

export function agentAvailabilityTone(availability: LogicalAgentAvailability): Tone {
  if (availability === "ready") return "good";
  if (availability === "busy") return "info";
  if (availability === "pending") return "warn";
  // Offline is the loud tier — same severity reading as the node presence dot.
  return "bad";
}

/** Runtime-mark tone for a node's agent. Unknown ("no signal yet") falls
    through to neutral — the canonical reading for an unrecognized state
    (lib/statusTone.ts); deliberate "off" is passed via options.disabled by
    callers that know it. */
export function agentStatusTone(agentStatus: string, options?: { disabled?: boolean }): Tone {
  if (options?.disabled) return "neutral";
  if (agentStatus === "ready") return "good";
  if (agentStatus === "failed") return "bad";
  return "neutral";
}

export type NodeAgentPresence = "online" | "offline" | "disabled";

/**
 * Whether one executor on a computer can take work right now.
 *
 * Readiness alone is not presence: the daemon's last report keeps saying
 * "ready" after the machine goes dark, so a runtime dot read as available on a
 * computer that could not accept a single dispatch. Presence folds the
 * machine's liveness into the agent's own state — a dark computer has no
 * online agents, whatever it last reported.
 */
export function nodeAgentPresence(
  node: ControlPanelDaemonNodeRecord,
  agent: AgentName,
): NodeAgentPresence {
  if (node.disabledAgents?.includes(agent)) return "disabled";
  if (!isNodeOnline(node)) return "offline";
  return (node.agents?.[agent] ?? "unknown") === "ready" ? "online" : "offline";
}

export function nodeAgentPresenceLabel(presence: NodeAgentPresence, t: TFunction): string {
  if (presence === "disabled") return t("admin.v2.agent_disabled");
  return presence === "online" ? t("nodes.presence_online") : t("nodes.presence_offline");
}

export function formatRelativeTime(value: string | undefined, t: TFunction): string {
  if (!value) return t("admin.time.never");
  const deltaMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(deltaMs)) return t("admin.time.unknown");
  if (deltaMs < 1_000) return t("admin.time.now");

  const seconds = Math.floor(deltaMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const locale = typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (hours < 24) return rtf.format(-hours, "hour");
  // Without these a three-month-old agent read "Created 2160 hours ago".
  if (days < 7) return rtf.format(-days, "day");
  if (days < 30) return rtf.format(-Math.floor(days / 7), "week");
  if (days < 365) return rtf.format(-Math.floor(days / 30), "month");
  return rtf.format(-Math.floor(days / 365), "year");
}

export interface EmployeeNodeSummary {
  id: string;
  displayName: string;
  email?: string;
  departmentId?: string;
  departmentName?: string;
  nodeCount: number;
  readyCount: number;
  runningCount: number;
  failedCount: number;
  nodes: ControlPanelDaemonNodeRecord[];
  /** Pinned personal-computer limit, or null when the org default applies. */
  maxLocalComputers: number | null;
  /** The limit actually in force — the override when pinned, the org default otherwise. */
  effectiveMaxLocalComputers?: number;
  /** Live personal computers the employee owns, counted from their nodes. */
  localComputerCount: number;
}

/** Employees who own more personal computers than their limit now allows.

    Lowering a limit never disconnects a computer, so this state is reachable
    and worth surfacing: the employee keeps working but cannot add another. */
export function isOverLocalComputerLimit(
  member: Pick<EmployeeNodeSummary, "localComputerCount" | "effectiveMaxLocalComputers">,
): boolean {
  if (member.effectiveMaxLocalComputers === undefined) return false;
  return member.localComputerCount > member.effectiveMaxLocalComputers;
}

/** "2/3" when a limit is known, otherwise just the count. */
export function localComputerUsageLabel(
  member: Pick<EmployeeNodeSummary, "localComputerCount" | "effectiveMaxLocalComputers">,
): string {
  if (member.effectiveMaxLocalComputers === undefined) return String(member.localComputerCount);
  return `${member.localComputerCount}/${member.effectiveMaxLocalComputers}`;
}

export type EmployeeQuickFilter = "all" | "running" | "ready" | "idle" | "failed" | "unassigned";
export type EmployeeSummaryStatusKey = "running" | "ready" | "failed" | "idle" | "no_nodes";
type EmployeeSummaryTone = Tone;

export function matchesEmployeeQuickFilter(
  member: EmployeeNodeSummary,
  filter: EmployeeQuickFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "running") return member.runningCount > 0;
  if (filter === "ready") return member.readyCount > 0;
  if (filter === "failed") return member.failedCount > 0;
  if (filter === "idle") {
    return member.nodeCount > 0
      && member.runningCount === 0
      && member.readyCount === 0
      && member.failedCount === 0;
  }
  return member.nodeCount === 0;
}

export function employeeSummaryStatus(
  member: EmployeeNodeSummary,
): { tone: EmployeeSummaryTone; key: EmployeeSummaryStatusKey } {
  if (member.runningCount > 0) return { tone: "info", key: "running" };
  if (member.readyCount > 0) return { tone: "good", key: "ready" };
  if (member.failedCount > 0) return { tone: "bad", key: "failed" };
  if (member.nodeCount > 0) return { tone: "neutral", key: "idle" };
  return { tone: "neutral", key: "no_nodes" };
}

/**
 * Employee fleet health, most-urgent first — the order the employee list
 * bands in. Not the order `EmployeeSummaryStatusKey` happens to be declared
 * in: that union lists the states, this ranks them. An admin opens this list
 * to find the people whose machines need something, so a failure sorts above
 * a healthy fleet and an employee with no computer at all sorts last.
 */
export const EMPLOYEE_SUMMARY_STATUS_ORDER: readonly EmployeeSummaryStatusKey[] = [
  "failed",
  "running",
  "ready",
  "idle",
  "no_nodes",
];

/**
 * Employees partitioned by fleet health, in `EMPLOYEE_SUMMARY_STATUS_ORDER`.
 * `employeeSummaryStatus` is already exclusive — every employee has exactly
 * one — so this is a true partition, which is what a band may claim to be.
 */
export function employeesByStatus(
  members: EmployeeNodeSummary[],
): Record<EmployeeSummaryStatusKey, EmployeeNodeSummary[]> {
  const grouped = Object.fromEntries(
    EMPLOYEE_SUMMARY_STATUS_ORDER.map((key) => [key, [] as EmployeeNodeSummary[]]),
  ) as Record<EmployeeSummaryStatusKey, EmployeeNodeSummary[]>;
  for (const member of members) grouped[employeeSummaryStatus(member).key].push(member);
  return grouped;
}

/**
 * Fleet lifecycle, most-urgent first — the order the computer list bands in.
 *
 * This is NOT the quick-filter chip set: those slices deliberately OVERLAP
 * (`running` is a superset of `ready`, `failed` also catches `stale`), so
 * they cannot partition a list. `visualStatus` can — it returns exactly one
 * value per node — which is why the bands key off it instead.
 */
export const NODE_STATUS_ORDER: readonly string[] = [
  "failed",
  "stale",
  "busy",
  "running",
  "provisioning",
  "ready",
  "stopped",
];

/**
 * Computers partitioned by `visualStatus`, ordered by `NODE_STATUS_ORDER`,
 * with empty bands dropped.
 *
 * Returns pairs rather than a record because a node's status arrives over the
 * wire: `SandboxStatus` is a closed union in THIS build, but a backend one
 * release ahead can send a value it does not contain, and that node still has
 * to land in a band (appended after the known ones, alphabetically) rather
 * than vanish from a list that claims to show the whole fleet.
 */
export function nodesByStatus(
  nodes: ControlPanelDaemonNodeRecord[],
): { status: string; nodes: ControlPanelDaemonNodeRecord[] }[] {
  const grouped = new Map<string, ControlPanelDaemonNodeRecord[]>();
  for (const node of nodes) {
    const status = visualStatus(node);
    grouped.set(status, [...(grouped.get(status) ?? []), node]);
  }
  const known = NODE_STATUS_ORDER.filter((status) => grouped.has(status));
  const unknown = [...grouped.keys()]
    .filter((status) => !NODE_STATUS_ORDER.includes(status))
    .sort();
  return [...known, ...unknown].map((status) => ({ status, nodes: grouped.get(status) ?? [] }));
}

export function employeeEmptyStateTranslationKey(
  query: string,
  filter: EmployeeQuickFilter,
): "admin.v2.no_match" | "admin.v2.no_employees_for_filter" {
  return query.trim() || filter === "all"
    ? "admin.v2.no_match"
    : "admin.v2.no_employees_for_filter";
}

export function buildEmployeeSummaries(
  employees: EmployeeRecord[],
  nodes: ControlPanelDaemonNodeRecord[],
): EmployeeNodeSummary[] {
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const nodesByEmployee = new Map<string, ControlPanelDaemonNodeRecord[]>();

  for (const node of nodes) {
    if (!node.employeeId) continue;
    const current = nodesByEmployee.get(node.employeeId) ?? [];
    nodesByEmployee.set(node.employeeId, [...current, node]);
  }

  const ids = new Set<string>([
    ...employees.map((employee) => employee.id),
    ...nodes.map((node) => node.employeeId).filter((id): id is string => Boolean(id)),
  ]);
  return [...ids].sort().map((id) => {
    const employee = employeeById.get(id);
    const employeeNodes = nodesByEmployee.get(id) ?? [];
    // Employee summaries are categorical: an idle ready Computer must not also
    // make its employee look like they have an actively running agent.
    const readyCount = employeeNodes.filter((node) => visualStatus(node) === "ready").length;
    const runningCount = employeeNodes.filter((node) => visualStatus(node) === "running").length;
    const failedCount = employeeNodes.filter((node) => matchesNodeQuickFilter(node, "failed")).length;
    // Counted from the nodes on screen rather than the server's tally so the
    // ratio stays consistent with the computers listed beside it.
    const localComputerCount = employeeNodes.filter(
      (node) => nodeOwnershipProfile(node) === "local",
    ).length;
    return {
      id,
      displayName: employee?.displayName || id,
      email: employee?.email,
      departmentId: employee?.departmentId,
      departmentName: employee?.departmentName,
      nodeCount: employeeNodes.length,
      readyCount,
      runningCount,
      failedCount,
      nodes: employeeNodes,
      maxLocalComputers: employee?.maxLocalComputers ?? null,
      effectiveMaxLocalComputers: employee?.effectiveMaxLocalComputers,
      localComputerCount,
    };
  });
}

/**
 * Sort keys for the admin node table. There is deliberately no `status` key:
 * health is rendered as pills INSIDE the node cell rather than in a column of
 * its own, and a sort the header cannot offer is a sort no reader can reach.
 * Give status its own column first if this table ever needs to order by it.
 */
export type NodeSortKey = "node" | "employee" | "runtimes";

/**
 * Sortable columns for the admin node table, in header order.
 *
 * The employee column takes the map rather than an id because the row prints
 * the owner's display NAME; sorting by `employeeId` would order the table by
 * a string that is nowhere on screen.
 */
export function nodeSortColumns(
  employeeById: ReadonlyMap<string, EmployeeRecord>,
): readonly SortColumn<ControlPanelDaemonNodeRecord, NodeSortKey>[] {
  const ownerName = (node: ControlPanelDaemonNodeRecord) =>
    (node.employeeId && employeeById.get(node.employeeId)?.displayName) || node.employeeId || "";
  return [
    // Same label rule as `stableNodeOrder`: an unnamed machine sorts under its id.
    { key: "node", compare: byText((node) => node.displayName?.trim() || node.id) },
    {
      key: "employee",
      compare: byText(ownerName),
      // "Nobody owns this" is a gap, not a name — it belongs at the bottom
      // whichever way the column is pointed.
      isMissing: (node) => !node.employeeId,
    },
    {
      key: "runtimes",
      compare: byNumber((node) => visibleNodeAgentNames(node).length),
      defaultDirection: "desc",
    },
  ];
}

export type EmployeeSortKey = "employee" | "computers" | "localLimit" | "running" | "ready";

/**
 * Sortable columns for the admin employee table, in header order.
 *
 * Every count column opens descending: a reader sorting by "Running" is
 * asking who has the most work in flight, and an ascending first click would
 * answer with a screenful of zeroes.
 */
export function employeeSortColumns(): readonly SortColumn<EmployeeNodeSummary, EmployeeSortKey>[] {
  return [
    { key: "employee", compare: byText((member) => member.displayName) },
    { key: "computers", compare: byNumber((member) => member.nodeCount), defaultDirection: "desc" },
    {
      key: "localLimit",
      // The ratio's numerator is what varies per person; the cap beside it is
      // usually the org default, so ordering by usage is the useful sort.
      compare: byNumber((member) => member.localComputerCount),
      defaultDirection: "desc",
    },
    { key: "running", compare: byNumber((member) => member.runningCount), defaultDirection: "desc" },
    { key: "ready", compare: byNumber((member) => member.readyCount), defaultDirection: "desc" },
  ];
}

// Agents are placed on computers, not owned by employees. An agent belongs to a
// set of nodes when one of its live placements runs on one of them — this is the
// only correct way to associate agents with an employee (via the employee's
// nodes), never agent.employeeId.
export function agentsOnNodes(nodeIds: Iterable<string>, agents: EmployeeAgent[]): EmployeeAgent[] {
  const ids = new Set(nodeIds);
  return agents.filter(
    (agent) =>
      !agent.deletedAt &&
      agent.placements.some(
        (placement) => placement.desiredState !== "removed"
          && ids.has(placement.runtimeNodeId || placement.daemonNodeId),
      ),
  );
}

export function readStoredNodeTokens(): StoredNodeTokenMap {
  return { ...volatileNodeTokens };
}

export function writeStoredNodeToken(nodeId: string, token: StoredNodeToken): void {
  volatileNodeTokens = { ...volatileNodeTokens, [nodeId]: token };
}

export interface NodeLocalityFlags {
  hasCachedCredentials: boolean;
  isColocatedLive: boolean;
}

export type NodeOwnershipProfile = "managed" | "local" | "pending";
export type NodeSandboxProfile = "boxlite" | "host" | "pending";

export type NodeLocalityKind = "this_host" | "saved_here" | "remote";

/** Management ownership is independent of the daemon's sandbox implementation. */
export function nodeOwnershipProfile(node: Pick<ControlPanelDaemonNodeRecord, "nodeLocation" | "sandboxMode">): NodeOwnershipProfile {
  if (node.nodeLocation === "managed") return "managed";
  if (node.nodeLocation === "employee-device") return "local";
  return "pending";
}

export function nodeSandboxProfile(
  node: Pick<ControlPanelDaemonNodeRecord, "sandboxMode">,
): NodeSandboxProfile {
  if (node.sandboxMode === "boxlite") return "boxlite";
  if (node.sandboxMode === "none") return "host";
  return "pending";
}

export function nodeLocalityKinds(
  node: ControlPanelDaemonNodeRecord,
  options: { storedTokens: StoredNodeTokenMap; colocated: boolean },
): Array<Exclude<NodeLocalityKind, "remote">> {
  if (!options.colocated) return [];
  const kinds: Array<Exclude<NodeLocalityKind, "remote">> = [];
  const cached = options.storedTokens[node.id];
  if (cached?.nodeToken || cached?.sandboxToken || cached?.daemonCommand) kinds.push("saved_here");
  return kinds;
}

export function nodeLocalityFlags(
  node: ControlPanelDaemonNodeRecord,
  options: { storedTokens: StoredNodeTokenMap; colocated: boolean },
): NodeLocalityFlags {
  const cached = options.storedTokens[node.id];
  return {
    hasCachedCredentials: Boolean(cached?.nodeToken || cached?.sandboxToken || cached?.daemonCommand),
    isColocatedLive: false,
  };
}

export function resolveNodeCredentials(
  node: ControlPanelDaemonNodeRecord,
  storedToken?: StoredNodeToken,
  backendUrl = defaultBackendUrl(),
): {
  sandboxToken?: string;
  nodeToken?: string;
  daemonCommand?: string;
  source: "none" | "cache" | "server" | "cache+server";
} {
  const nodeToken = storedToken?.nodeToken ?? node.nodeToken;
  const sandboxToken = storedToken?.sandboxToken;
  const daemonCommand = storedToken?.daemonCommand
    ?? (nodeToken ? buildDaemonStartCommand(node, nodeToken, backendUrl) : undefined);
  const fromCache = Boolean(storedToken?.nodeToken || storedToken?.sandboxToken || storedToken?.daemonCommand);
  const fromServer = Boolean(node.nodeToken);
  let source: "none" | "cache" | "server" | "cache+server" = "none";
  if (fromCache && fromServer) source = "cache+server";
  else if (fromCache) source = "cache";
  else if (fromServer) source = "server";
  if (!nodeToken && !sandboxToken && !daemonCommand) {
    return { source: "none" };
  }
  return { sandboxToken, nodeToken, daemonCommand, source };
}

/** Persist ephemeral control-panel node tokens before the backend drops them from RAM. */
export function upsertStoredCredentialsFromNodes(
  map: StoredNodeTokenMap,
  nodes: ControlPanelDaemonNodeRecord[],
  backendUrl = defaultBackendUrl(),
): StoredNodeTokenMap | null {
  let next = map;
  let changed = false;
  for (const node of nodes) {
    if (!node.nodeToken) continue;
    const existing = next[node.id];
    const merged: StoredNodeToken = {
      employeeId: node.employeeId ?? existing?.employeeId,
      nodeToken: node.nodeToken,
      sandboxToken: existing?.sandboxToken,
      daemonCommand: existing?.daemonCommand ?? buildDaemonStartCommand(node, node.nodeToken, backendUrl),
      savedAt: existing?.savedAt ?? new Date().toISOString(),
    };
    if (
      existing?.nodeToken !== merged.nodeToken
      || existing?.daemonCommand !== merged.daemonCommand
      || existing?.employeeId !== merged.employeeId
    ) {
      next = { ...next, [node.id]: merged };
      changed = true;
    }
  }
  return changed ? next : null;
}

export function persistStoredNodeTokenMap(map: StoredNodeTokenMap): void {
  volatileNodeTokens = { ...map };
}

export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function truncateId(id: string, head = 4, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Initials for employee/operator avatars in admin drawers. */
export function initialsOf(value: string): string {
  const trimmed = value.replace(/^@/, "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
