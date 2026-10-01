/* Demo data behind the README snapshots.

   Every value here is fictional and shaped like the real API responses in
   web/src/types.ts and relay-core, so the pages render exactly as they do
   against a backend. Timestamps are relative to the moment of capture: a
   snapshot always reads "12m ago", never a date that has drifted into the
   past. */

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms) => new Date(NOW - ms).toISOString();
const dateOnly = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

const EMPLOYEE = "ada";
const WORKSPACE_ROOT = "/Users/ada/relay-workspace";

/* ------------------------------------------------------------------ */
/* Computers                                                           */
/* ------------------------------------------------------------------ */

const CAPABILITIES = [
  "runtime-refresh", "generated-files", "workspace-read-shared", "structured-agent-events",
  "thread-workspaces", "project-workspaces", "task-workspaces", "round-result",
  "work-results", "produced-files", "handoff-validation", "agent-skills",
];

const AGENT_VERSIONS = {
  claude: { version: "2.1.4", adapter: "cli" },
  codex: { version: "0.52.0", adapter: "cli" },
  pi: { version: "0.9.3", adapter: "cli" },
  kimi: { version: "1.6.0", adapter: "cli" },
};

function node({ id, displayName, employeeId, workspaceId, managedNodeId, online = true, status = "ready", activeRuns = [], seenMs = 4_000, createdDays = 40 }) {
  return {
    id,
    displayName,
    employeeId,
    workspacePath: managedNodeId ? "/workspace" : `/Users/${employeeId}/relay-workspace`,
    workspaceId,
    ...(managedNodeId ? { managedNodeId, nodeLocation: "managed", sandboxMode: "boxlite" } : { nodeLocation: "employee-device", sandboxMode: "none" }),
    capabilities: CAPABILITIES,
    status: online ? status : "stopped",
    agents: { claude: "ready", pi: "ready", codex: "ready", kimi: "ready" },
    agentDetails: AGENT_VERSIONS,
    maxConcurrentRuns: 4,
    createdAt: ago(createdDays * DAY),
    updatedAt: ago(seenMs),
    lastSeenAt: ago(seenMs),
    lastSeenAgeMs: seenMs,
    queuedCommandCount: 0,
    activeRuns,
    online,
    stale: !online,
  };
}

const MACBOOK_ID = "node_ada_macbook";
const BUILDBOX_ID = "node_buildbox_01";
const MACBOOK = `device:${EMPLOYEE}:ada-macbook-pro`;
const BUILDBOX = "managed:mn_buildbox_01";

/* ------------------------------------------------------------------ */
/* Agents and teams                                                    */
/* ------------------------------------------------------------------ */

function agent({ id, displayName, executorKind, defaultRole, avatar, availability, instructions, onBuildBox = false, skills = [] }) {
  const computerId = onBuildBox ? BUILDBOX : MACBOOK;
  const daemonNodeId = onBuildBox ? BUILDBOX_ID : MACBOOK_ID;
  return {
    id,
    supervisorEmployeeId: EMPLOYEE,
    displayName,
    profileImageUrl: `/avatars/agents/${avatar}.svg`,
    executorKind,
    instructions,
    defaultRole,
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    skills,
    enabled: true,
    version: 3,
    availability,
    computerId,
    bindingStatus: "available",
    placements: [{
      id: `placement_${id}`,
      agentId: id,
      employeeId: EMPLOYEE,
      daemonNodeId,
      runtimeNodeId: daemonNodeId,
      computerId,
      ...(onBuildBox ? { managedNodeId: "mn_buildbox_01" } : {}),
      nodeDisplayName: onBuildBox ? "Build Box 01" : "Ada's MacBook Pro",
      nodeOwnership: onBuildBox ? "managed" : "employee-device",
      nodeSandboxMode: onBuildBox ? "boxlite" : "none",
      executorKind,
      desiredState: "active",
      status: availability === "busy" ? "busy" : "ready",
      priority: 0,
      agentVersion: 3,
      workspacePolicy: {},
      conditions: [],
      createdAt: ago(32 * DAY),
      updatedAt: ago(5 * MINUTE),
    }],
    createdAt: ago(32 * DAY),
    updatedAt: ago(2 * HOUR),
    deletedAt: null,
  };
}

const SKILL_BILLING = { source: "catalog", skillId: "skill_billing_runbook", slug: "billing-runbook", name: "billing-runbook", namespace: "acme", description: "How the billing pipeline is laid out, and how to verify a change to it.", available: true, pin: "latest" };
const SKILL_REVIEW = { source: "catalog", skillId: "skill_review_checklist", slug: "review-checklist", name: "review-checklist", namespace: "acme", description: "The review bar for backend changes: concurrency, migrations, rollback.", available: true, pin: "latest" };
const SKILL_RELEASE = { source: "catalog", skillId: "skill_release_notes", slug: "release-notes", name: "release-notes", namespace: "acme", description: "Turn a merged change set into customer-facing release notes.", available: true, pin: "latest" };

export const agents = [
  agent({ id: "agent_aria", displayName: "Aria", executorKind: "claude", defaultRole: "implementer", avatar: "bottts-03", availability: "ready", skills: [SKILL_BILLING, SKILL_RELEASE],
    instructions: "You own backend changes for the billing platform. Prefer small, reviewable diffs and always add a regression test for a bug fix." }),
  agent({ id: "agent_cascade", displayName: "Cascade", executorKind: "codex", defaultRole: "reviewer", avatar: "bottts-07", availability: "busy", skills: [SKILL_REVIEW],
    instructions: "Review for correctness under concurrency, migration safety, and rollback. Block on missing tests." }),
  agent({ id: "agent_pixel", displayName: "Pixel", executorKind: "kimi", defaultRole: "tester", avatar: "bottts-11", availability: "ready",
    instructions: "Write and run end-to-end checks. Report the exact command and its output." }),
  agent({ id: "agent_scout", displayName: "Scout", executorKind: "pi", defaultRole: "planner", avatar: "bottts-14", availability: "ready",
    instructions: "Break a goal into ordered, verifiable steps before anyone writes code." }),
  agent({ id: "agent_forge", displayName: "Forge", executorKind: "claude", defaultRole: "fixer", avatar: "bottts-05", availability: "ready", onBuildBox: true,
    instructions: "Repair failing builds on the shared runner. Reproduce first, then fix the root cause." }),
];

const agentById = Object.fromEntries(agents.map((item) => [item.id, item]));

function memberSummary(id) {
  const { displayName, profileImageUrl, executorKind, enabled, availability, defaultRole } = agentById[id];
  return { id, displayName, profileImageUrl, executorKind, enabled, availability, defaultRole };
}

function team({ id, name, avatar, lead, members, collaborationStyle, acceptanceCriteria, responsibilities }) {
  return {
    id,
    ownerEmployeeId: EMPLOYEE,
    name,
    profileImageUrl: `/avatars/teams/${avatar}.svg`,
    collaborationStyle,
    leadAgentId: lead,
    memberAgentIds: members,
    computerId: MACBOOK,
    memberConfigs: Object.fromEntries(members.map((member) => [member, {
      role: agentById[member].defaultRole,
      responsibility: responsibilities[member],
      required: true,
      participation: "always",
    }])),
    acceptanceCriteria,
    enabled: true,
    members: members.map(memberSummary),
    lead: memberSummary(lead),
    createdAt: ago(28 * DAY),
    updatedAt: ago(3 * HOUR),
    deletedAt: null,
  };
}

export const teams = [
  team({
    id: "team_platform_guild", name: "Platform Guild", avatar: "shape-grid-02", lead: "agent_aria",
    members: ["agent_aria", "agent_cascade", "agent_pixel"], collaborationStyle: "build_review",
    acceptanceCriteria: ["A regression test fails before the change and passes after it", "No migration without a rollback note"],
    responsibilities: { agent_aria: "Implements the change", agent_cascade: "Reviews every diff before it lands", agent_pixel: "Runs the end-to-end suite" },
  }),
  team({
    id: "team_infra_response", name: "Infra Response", avatar: "shape-grid-05", lead: "agent_scout",
    members: ["agent_scout", "agent_aria", "agent_cascade"], collaborationStyle: "pipeline",
    acceptanceCriteria: ["Alert noise drops without hiding a real incident"],
    responsibilities: { agent_scout: "Plans the rollout", agent_aria: "Applies the change", agent_cascade: "Verifies dashboards and alerts" },
  }),
  team({
    id: "team_growth_pod", name: "Growth Pod", avatar: "shape-grid-09", lead: "agent_pixel",
    members: ["agent_pixel", "agent_scout"], collaborationStyle: "lead_led",
    acceptanceCriteria: ["Experiment ships behind a flag with a success metric"],
    responsibilities: { agent_pixel: "Leads the experiment", agent_scout: "Drafts the plan and the metric" },
  }),
];

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export const projects = [
  {
    id: "project_billing", ownerEmployeeId: EMPLOYEE, name: "Billing Platform",
    description: "Invoice generation, exports, and the ledger reconciliation jobs.",
    computerId: MACBOOK, workspaceLayout: "project", workspaceSubpath: "projects/billing-platform",
    leadAgentId: "agent_aria", enabled: true, version: 4, createdAt: ago(26 * DAY), updatedAt: ago(40 * MINUTE),
    members: [
      { agentId: "agent_aria", role: "implementer", responsibilities: "Owns export and invoice code paths", enabled: true },
      { agentId: "agent_cascade", role: "reviewer", responsibilities: "Reviews concurrency and migrations", enabled: true },
      { agentId: "agent_pixel", role: "tester", responsibilities: "Keeps the end-to-end billing suite green", enabled: true },
    ],
  },
  {
    id: "project_infra", ownerEmployeeId: EMPLOYEE, name: "Platform Infrastructure",
    description: "The public API edge, CI runners, and the alerting stack.",
    computerId: MACBOOK, workspaceLayout: "project", workspaceSubpath: "projects/platform-infrastructure",
    leadAgentId: "agent_scout", enabled: true, version: 3, createdAt: ago(21 * DAY), updatedAt: ago(6 * MINUTE),
    members: [
      { agentId: "agent_scout", role: "planner", responsibilities: "Plans rollouts and capacity", enabled: true },
      { agentId: "agent_aria", role: "implementer", responsibilities: "Applies infrastructure changes", enabled: true },
      { agentId: "agent_cascade", role: "reviewer", responsibilities: "Verifies dashboards and alerts", enabled: true },
    ],
  },
  {
    id: "project_onboarding", ownerEmployeeId: EMPLOYEE, name: "Onboarding Revamp",
    description: "The first-run checklist and the workspace setup flow.",
    computerId: MACBOOK, workspaceLayout: "project", workspaceSubpath: "projects/onboarding-revamp",
    leadAgentId: "agent_scout", enabled: true, version: 2, createdAt: ago(12 * DAY), updatedAt: ago(5 * HOUR),
    members: [
      { agentId: "agent_scout", role: "planner", responsibilities: "Sequences the redesign", enabled: true },
      { agentId: "agent_pixel", role: "tester", responsibilities: "Checks every step on a clean account", enabled: true },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

const HERO_ID = "thread_billing_export";
const HERO_GOAL = "Two exports for the same tenant can write the same invoice batch twice. Find the race in the billing export job, fix it, and prove it with a test.";

const ariaOutput = jsonl([
  { type: "assistant", message: { id: "msg_a1", content: [
    { type: "text", text: "I'll start by reading the export job and how it claims a batch." },
    { type: "tool_use", id: "tool_a1", name: "Read", input: { file_path: "billing/export/job.py" } },
    { type: "tool_use", id: "tool_a2", name: "Grep", input: { pattern: "claim_batch", path: "billing/" } },
  ] } },
  { type: "assistant", message: { id: "msg_a2", content: [
    { type: "text", text: "Found it. `claim_batch` reads the batch row and writes `status = 'exporting'` in two separate statements, so two workers can both see `pending` before either one writes." },
    { type: "tool_use", id: "tool_a3", name: "Edit", input: { file_path: "billing/export/job.py" } },
    { type: "tool_use", id: "tool_a4", name: "Write", input: { file_path: "tests/billing/test_export_race.py" } },
    { type: "tool_use", id: "tool_a5", name: "Bash", input: { command: "pytest tests/billing/test_export_race.py -q" } },
  ] } },
  { type: "assistant", message: { id: "msg_a3", content: [
    { type: "text", text: [
      "The race is fixed. The claim is now a single conditional update, so only one worker can win a batch:",
      "",
      "```python",
      "claimed = db.execute(",
      "    \"UPDATE invoice_batches SET status = 'exporting', worker_id = :worker \"",
      "    \"WHERE id = :batch AND status = 'pending'\",",
      "    {\"batch\": batch_id, \"worker\": worker_id},",
      ").rowcount == 1",
      "```",
      "",
      "| Check | Before | After |",
      "| --- | --- | --- |",
      "| 50 concurrent claims on one batch | 7 duplicate exports | 0 |",
      "| `tests/billing` | 41 passed | 44 passed |",
      "",
      "Handing to **Cascade** for review — the change touches `job.py` and adds `test_export_race.py`.",
    ].join("\n") },
  ] } },
  { type: "result", subtype: "success", is_error: false, result: "" },
]);

const cascadeOutput = jsonl([
  { type: "turn.started" },
  { type: "item.completed", item: { id: "rs_1", type: "reasoning", text: "Checking that the conditional update is the only path that can move a batch out of pending." } },
  { type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "git diff --stat HEAD~1" } },
  { type: "item.completed", item: { id: "cmd_2", type: "command_execution", command: "rg \"status = 'exporting'\" billing/" } },
  { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: [
    "Reviewing the claim path. Two things so far:",
    "",
    "1. The conditional update is correct, and `rowcount == 1` is the right winner check.",
    "2. `retry_failed_batches` still sets `status = 'exporting'` without the guard — running the race test against that path next.",
  ].join("\n") } },
  { type: "item.started", item: { id: "cmd_3", type: "command_execution", command: "pytest tests/billing -q -k \"race or retry\"" } },
]);

const heroArtifacts = [
  { id: "artifact_job", kind: "workspace_file", title: "job.py", path: "billing/export/job.py", workspaceRelativePath: "billing/export/job.py", createdAt: ago(9 * MINUTE), agentRunId: "run_aria_1", bytes: 6_812, contentType: "text/x-python" },
  { id: "artifact_test", kind: "workspace_file", title: "test_export_race.py", path: "tests/billing/test_export_race.py", workspaceRelativePath: "tests/billing/test_export_race.py", createdAt: ago(9 * MINUTE), agentRunId: "run_aria_1", bytes: 2_304, contentType: "text/x-python" },
  { id: "artifact_notes", kind: "workspace_file", title: "EXPORT-RACE.md", path: "docs/EXPORT-RACE.md", workspaceRelativePath: "docs/EXPORT-RACE.md", createdAt: ago(9 * MINUTE), agentRunId: "run_aria_1", bytes: 1_920, contentType: "text/markdown" },
];

const ariaUsage = { input: 18_420, output: 3_960, cache: 96_300, total: 118_680 };

const heroRuns = [
  { id: "run_aria_1", agent: "claude", logicalAgentId: "agent_aria", daemonNodeId: MACBOOK_ID, role: "implementer", status: "completed", startedAt: ago(14 * MINUTE), completedAt: ago(9 * MINUTE), exitCode: 0, tokenUsage: ariaUsage, artifactIds: heroArtifacts.map((item) => item.id) },
  { id: "run_cascade_1", agent: "codex", logicalAgentId: "agent_cascade", daemonNodeId: MACBOOK_ID, role: "reviewer", status: "running", startedAt: ago(2 * MINUTE), artifactIds: [] },
];

const heroEvents = [
  { id: "ev_1", type: "agent.started", sessionId: HERO_ID, timestamp: ago(14 * MINUTE), runId: "run_aria_1", agent: "claude", logicalAgentId: "agent_aria", daemonNodeId: MACBOOK_ID, role: "implementer" },
  { id: "ev_2", type: "agent.output", sessionId: HERO_ID, timestamp: ago(10 * MINUTE), runId: "run_aria_1", agent: "claude", stream: "stdout", text: ariaOutput },
  ...heroArtifacts.map((artifact, index) => ({ id: `ev_art_${index}`, type: "artifact.created", sessionId: HERO_ID, timestamp: artifact.createdAt, artifact })),
  { id: "ev_3", type: "agent.completed", sessionId: HERO_ID, timestamp: ago(9 * MINUTE), runId: "run_aria_1", agent: "claude", status: "completed", exitCode: 0, tokenUsage: ariaUsage },
  { id: "ev_4", type: "agent.started", sessionId: HERO_ID, timestamp: ago(2 * MINUTE), runId: "run_cascade_1", agent: "codex", logicalAgentId: "agent_cascade", daemonNodeId: MACBOOK_ID, role: "reviewer" },
  { id: "ev_5", type: "agent.output", sessionId: HERO_ID, timestamp: ago(1 * MINUTE), runId: "run_cascade_1", agent: "codex", stream: "stdout", text: cascadeOutput },
];

function summary({ id, title, goal, status, minutes, agentKind, ownerAgentId, teamId, projectId, runCount = 1, artifactCount = 0, pendingDecision }) {
  return {
    id,
    title,
    taskGoal: goal ?? title,
    status,
    phase: status === "running" ? "running" : "created",
    daemonNodeId: MACBOOK_ID,
    computerId: MACBOOK,
    workspacePath: WORKSPACE_ROOT,
    workspaceLayout: projectId ? "project" : "thread",
    workspaceSubpath: projectId ? projects.find((item) => item.id === projectId).workspaceSubpath : `threads/${id}`,
    ownerEmployeeId: EMPLOYEE,
    ownerAgentId,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(status === "running" ? { currentAgent: agentKind } : {}),
    ...(pendingDecision ? { pendingDecision } : {}),
    participants: ["human"],
    participantAgentIds: teamId ? teams.find((item) => item.id === teamId).memberAgentIds : [ownerAgentId],
    artifactCount,
    workspaceArtifactCount: artifactCount,
    runCount,
    eventCount: runCount * 3 + 1,
    createdAt: ago((minutes + 25) * MINUTE),
    updatedAt: ago(minutes * MINUTE),
    /* A summary carries no history; the full record is served per thread. */
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
  };
}

const heroSummary = {
  ...summary({ id: HERO_ID, title: "Fix billing export race condition", goal: HERO_GOAL, status: "running", minutes: 1, agentKind: "codex", ownerAgentId: "agent_aria", teamId: "team_platform_guild", projectId: "project_billing", runCount: 2, artifactCount: heroArtifacts.length }),
  tokenUsage: ariaUsage,
  eventCount: heroEvents.length,
};

export const hero = {
  ...heroSummary,
  agentRuns: heroRuns,
  artifacts: heroArtifacts,
  events: heroEvents,
};

export const sessions = [
  heroSummary,
  summary({ id: "thread_rate_limit", title: "Add per-tenant rate limiting to the public API", status: "waiting_for_human", minutes: 18, agentKind: "claude", ownerAgentId: "agent_aria", projectId: "project_infra", teamId: "team_platform_guild", runCount: 3, artifactCount: 4, pendingDecision: "feedback" }),
  summary({ id: "thread_alert_thresholds", title: "Tune infra alert thresholds", status: "running", minutes: 6, agentKind: "pi", ownerAgentId: "agent_scout", projectId: "project_infra", teamId: "team_infra_response", runCount: 2, artifactCount: 1 }),
  summary({ id: "thread_chart_slowdown", title: "Investigate dashboard chart slowdown", status: "completed", minutes: 52, agentKind: "codex", ownerAgentId: "agent_cascade", projectId: "project_infra", runCount: 1, artifactCount: 2 }),
  summary({ id: "thread_onboarding", title: "Redesign onboarding checklist flow", status: "completed", minutes: 3 * 60, agentKind: "pi", ownerAgentId: "agent_scout", projectId: "project_onboarding", runCount: 4, artifactCount: 5 }),
  summary({ id: "thread_dependency_audit", title: "Weekly dependency audit", status: "completed", minutes: 5 * 60, agentKind: "kimi", ownerAgentId: "agent_pixel", runCount: 1, artifactCount: 1 }),
  summary({ id: "thread_capacity_plan", title: "Draft Q4 capacity plan for shared runners", status: "completed", minutes: 22 * 60, agentKind: "pi", ownerAgentId: "agent_scout", projectId: "project_infra", runCount: 2, artifactCount: 1 }),
  summary({ id: "thread_ci_cache", title: "Migrate CI cache to the shared runner", status: "failed", minutes: 26 * 60, agentKind: "claude", ownerAgentId: "agent_forge", projectId: "project_infra", runCount: 1 }),
  summary({ id: "thread_invoice_pdf", title: "Invoice PDF totals are off by one cent", status: "completed", minutes: 30 * 60, agentKind: "claude", ownerAgentId: "agent_aria", projectId: "project_billing", runCount: 2, artifactCount: 2 }),
];

/* ------------------------------------------------------------------ */
/* Issues and routines                                                 */
/* ------------------------------------------------------------------ */

function task({ ref, title, description = "", priority = "normal", status, due, agentId, teamId, projectId, sessionIds = [], minutes = 90, routine, note }) {
  const id = `task_mg${ref.slice(1, 5).toLowerCase()}7q_${ref.toLowerCase()}`;
  const lastActivity = note ? { id: `activity_${ref}`, createdAt: ago(minutes * MINUTE), message: note, ...(sessionIds[0] ? { sessionId: sessionIds[0] } : {}) } : undefined;
  return {
    id,
    title,
    description,
    priority,
    status,
    workflowStage: ["waiting_for_human", "blocked"].includes(status) ? "running" : status,
    acceptancePolicy: "human",
    ownerEmployeeId: EMPLOYEE,
    ...(projectId ? { projectId } : {}),
    ...(due === undefined ? {} : { dueDate: dateOnly(due) }),
    ...(agentId ? { assignedAgentId: agentId, assignedAgent: agentById[agentId].executorKind } : {}),
    ...(teamId ? { assignedTeamId: teamId } : {}),
    ...(["running", "review", "done", "waiting_for_human", "blocked"].includes(status) ? { startedAt: ago(minutes * MINUTE + 26 * HOUR) } : {}),
    ...(status === "done" ? { finishedAt: ago(minutes * MINUTE) } : {}),
    ...(status === "blocked" ? { blockedAt: ago(minutes * MINUTE), blockedFromStatus: "running", blockerReason: "Needs production read access to the shared runner cache." } : {}),
    isRoutine: Boolean(routine),
    routineEnabled: routine ? routine.enabled !== false : false,
    ...(routine ? { routineType: "task", routineCadence: routine.cadence, routineNextRunDate: dateOnly(routine.next), occurrenceIds: [] } : {}),
    linkedSessionIds: sessionIds,
    ...(lastActivity ? { lastActivity } : {}),
    createdAt: ago((minutes + 600) * MINUTE),
    updatedAt: ago(minutes * MINUTE),
    eventCount: 4 + sessionIds.length * 2,
    activityCount: note ? 3 : 0,
  };
}

export const tasks = [
  task({ ref: "B7D349", title: "Audit webhook retry backoff", priority: "low", status: "backlog", due: 9, minutes: 300 }),
  task({ ref: "B32E83", title: "Draft Q4 capacity plan for shared runners", status: "backlog", projectId: "project_infra", due: 12, agentId: "agent_scout", minutes: 22 * 60 }),
  task({ ref: "C0FBA2", title: "Document the export job runbook", priority: "low", status: "backlog", minutes: 900 }),
  task({ ref: "D573E3", title: "Redesign onboarding checklist flow", status: "assigned", due: 3, teamId: "team_growth_pod", projectId: "project_onboarding", minutes: 180 }),
  task({ ref: "E9F651", title: "Ship the welcome-email experiment", status: "assigned", projectId: "project_onboarding", due: 6, teamId: "team_growth_pod", minutes: 240 }),
  task({ ref: "F0CB49", title: "Fix billing export race condition", priority: "high", status: "running", due: 1, teamId: "team_platform_guild", projectId: "project_billing", sessionIds: [HERO_ID], minutes: 1, note: "Cascade is reviewing the claim path." }),
  task({ ref: "A41D07", title: "Tune infra alert thresholds", status: "running", projectId: "project_infra", due: 2, teamId: "team_infra_response", sessionIds: ["thread_alert_thresholds"], minutes: 6, note: "Scout drafted the rollout plan." }),
  task({ ref: "A8C2E5", title: "Add per-tenant rate limiting to the public API", priority: "high", status: "review", projectId: "project_infra", due: 4, teamId: "team_platform_guild", sessionIds: ["thread_rate_limit"], minutes: 18, note: "Ready for review: 4 files changed." }),
  task({ ref: "B6E1F4", title: "Investigate dashboard chart slowdown", status: "review", projectId: "project_infra", agentId: "agent_cascade", sessionIds: ["thread_chart_slowdown"], minutes: 52, note: "Root cause: unbounded tooltip re-render." }),
  task({ ref: "C2A9D8", title: "Migrate CI cache to the shared runner", status: "blocked", projectId: "project_infra", due: -1, agentId: "agent_forge", sessionIds: ["thread_ci_cache"], minutes: 26 * 60, note: "Blocked on cache credentials." }),
  task({ ref: "D7B3C1", title: "Invoice PDF totals are off by one cent", priority: "high", status: "done", agentId: "agent_aria", projectId: "project_billing", sessionIds: ["thread_invoice_pdf"], minutes: 30 * 60, note: "Rounding moved to the line-item level." }),
  task({ ref: "E5F0A6", title: "Rotate the staging signing key", status: "done", projectId: "project_infra", agentId: "agent_forge", minutes: 49 * 60, note: "Both keys accepted during cutover." }),
  task({ ref: "1A7C40", title: "Weekly dependency audit", description: "List outdated and vulnerable packages across every service and open an issue for anything critical.", status: "backlog", agentId: "agent_pixel", sessionIds: ["thread_dependency_audit"], minutes: 5 * 60, routine: { cadence: "weekly", next: 6 }, note: "3 upgrades proposed, 0 critical." }),
  task({ ref: "2B90E3", title: "Daily error-budget report", description: "Summarize yesterday's SLO burn per service and flag any budget below 20%.", status: "backlog", teamId: "team_infra_response", minutes: 7 * 60, routine: { cadence: "daily", next: 1 }, note: "All services within budget." }),
  task({ ref: "3C4D81", title: "Nightly flaky-test triage", description: "Re-run last night's failures, quarantine the flaky ones, and file the real ones.", priority: "high", status: "backlog", agentId: "agent_pixel", minutes: 9 * 60, routine: { cadence: "daily", next: 1 }, note: "2 tests quarantined." }),
  task({ ref: "4DA6F2", title: "Monthly cloud cost review", description: "Compare spend against last month by team and call out anything that grew more than 15%.", status: "backlog", agentId: "agent_scout", minutes: 6 * DAY / MINUTE, routine: { cadence: "monthly", next: 24 }, note: "Runner spend up 8%." }),
  task({ ref: "6F28C9", title: "Weekly on-call handoff summary", description: "Summarize open incidents, noisy alerts, and pending follow-ups for the next on-call.", status: "backlog", teamId: "team_infra_response", minutes: 2 * DAY / MINUTE, routine: { cadence: "weekly", next: 5 }, note: "2 follow-ups carried over." }),
  task({ ref: "7A35D0", title: "Monthly access review", description: "List every service account and token that has not been used in 30 days.", priority: "high", status: "backlog", agentId: "agent_forge", minutes: 11 * DAY / MINUTE, routine: { cadence: "monthly", next: 19 }, note: "4 stale tokens flagged." }),
  task({ ref: "8B42E1", title: "Daily standup digest", description: "Collect what every agent finished, is doing, and is blocked on since yesterday.", priority: "low", status: "backlog", agentId: "agent_scout", minutes: 8 * 60, routine: { cadence: "daily", next: 1 }, note: "Posted to #platform." }),
  task({ ref: "5E13B7", title: "Friday release notes draft", description: "Draft customer-facing notes from everything merged this week.", priority: "low", status: "backlog", agentId: "agent_aria", minutes: 4 * DAY / MINUTE, routine: { cadence: "weekly", next: 3, enabled: false } }),
];

/* ------------------------------------------------------------------ */
/* Computers as the API serves them                                    */
/* ------------------------------------------------------------------ */

const heroActiveRun = { commandId: "cmd_run_cascade_1", sessionId: HERO_ID, runId: "run_cascade_1", agent: "codex", logicalAgentId: "agent_cascade", placementId: "placement_agent_cascade", taskGoal: "Fix billing export race condition", workspacePath: WORKSPACE_ROOT, startedAt: ago(2 * MINUTE) };
const alertActiveRun = { commandId: "cmd_run_scout_1", sessionId: "thread_alert_thresholds", runId: "run_scout_1", agent: "pi", logicalAgentId: "agent_scout", placementId: "placement_agent_scout", taskGoal: "Tune infra alert thresholds", workspacePath: WORKSPACE_ROOT, startedAt: ago(6 * MINUTE) };

export const nodes = [
  node({ id: MACBOOK_ID, displayName: "Ada's MacBook Pro", employeeId: EMPLOYEE, workspaceId: "ada-macbook-pro", status: "running", activeRuns: [heroActiveRun, alertActiveRun] }),
  node({ id: BUILDBOX_ID, displayName: "Build Box 01", employeeId: EMPLOYEE, workspaceId: "buildbox-01", managedNodeId: "mn_buildbox_01", seenMs: 7_000 }),
];

export const fleet = [
  ...nodes,
  node({ id: "node_marcus_studio", displayName: "Marcus's Mac Studio", employeeId: "marcus", workspaceId: "marcus-mac-studio", seenMs: 9_000, createdDays: 21 }),
  node({ id: "node_priya_thinkpad", displayName: "Priya's ThinkPad", employeeId: "priya", workspaceId: "priya-thinkpad", online: false, seenMs: 19 * HOUR, createdDays: 18 }),
  node({ id: "node_review_runner", displayName: "Review Runner", employeeId: "jonas", workspaceId: "review-runner", managedNodeId: "mn_review_runner", seenMs: 3_000, createdDays: 9 }),
];

export const managedNodes = [
  { id: "mn_buildbox_01", displayName: "Build Box 01", employeeId: EMPLOYEE, assignmentMode: "dedicated", provider: "boxlite", profile: "standard", sandboxMode: "boxlite", workspacePolicy: {}, desiredState: "running", generation: 2, phase: "ready", activeDaemonNodeId: BUILDBOX_ID, conditions: [], createdAt: ago(40 * DAY), updatedAt: ago(2 * HOUR) },
  { id: "mn_review_runner", displayName: "Review Runner", employeeId: "jonas", assignmentMode: "dedicated", provider: "boxlite", profile: "standard", sandboxMode: "boxlite", workspacePolicy: {}, desiredState: "running", generation: 1, phase: "ready", activeDaemonNodeId: "node_review_runner", conditions: [], createdAt: ago(9 * DAY), updatedAt: ago(1 * HOUR) },
];

export const employees = [
  { id: EMPLOYEE, handle: "ada", displayName: "Ada Chen", email: "ada@acme.example", departmentId: "platform", departmentName: "Platform", effectiveMaxLocalComputers: 3, localComputerCount: 1, createdAt: ago(60 * DAY), updatedAt: ago(2 * DAY) },
  { id: "marcus", handle: "marcus", displayName: "Marcus Lee", email: "marcus@acme.example", departmentId: "platform", departmentName: "Platform", effectiveMaxLocalComputers: 3, localComputerCount: 1, createdAt: ago(44 * DAY), updatedAt: ago(5 * DAY) },
  { id: "priya", handle: "priya", displayName: "Priya Nair", email: "priya@acme.example", departmentId: "growth", departmentName: "Growth", effectiveMaxLocalComputers: 3, localComputerCount: 1, createdAt: ago(30 * DAY), updatedAt: ago(8 * DAY) },
  { id: "jonas", handle: "jonas", displayName: "Jonas Weber", email: "jonas@acme.example", departmentId: "security", departmentName: "Security", maxLocalComputers: 1, effectiveMaxLocalComputers: 1, localComputerCount: 0, createdAt: ago(16 * DAY), updatedAt: ago(1 * DAY) },
];

/* ------------------------------------------------------------------ */
/* Admin dashboard                                                     */
/* ------------------------------------------------------------------ */

const DAILY_SESSIONS = [18, 24, 21, 9, 7, 27, 31, 29, 34, 26, 11, 8, 36, 41];
const dailyCounts = DAILY_SESSIONS.map((count, index) => {
  const failed = Math.round(count * 0.06);
  return { date: dateOnly(index - DAILY_SESSIONS.length + 1), count, completed: count - failed - (index === DAILY_SESSIONS.length - 1 ? 4 : 0), failed };
});

export const dashboardSessions = {
  total: 1_284,
  last24h: DAILY_SESSIONS.at(-1),
  last7d: DAILY_SESSIONS.slice(-7).reduce((sum, count) => sum + count, 0),
  statusCounts: { running: 4, waiting_for_human: 3, completed: 1_198, failed: 61, cancelled: 18 },
  dailyCounts,
  topEmployees: [
    { employeeId: EMPLOYEE, sessionCount: 412 },
    { employeeId: "marcus", sessionCount: 356 },
    { employeeId: "priya", sessionCount: 301 },
    { employeeId: "jonas", sessionCount: 215 },
  ],
};

const usage = (input, output, cache) => ({ input, output, cache, total: input + output + cache });
const dailyTokens = DAILY_SESSIONS.map((count, index) => ({ date: dateOnly(index - DAILY_SESSIONS.length + 1), ...usage(count * 21_400, count * 5_100, count * 88_000) }));
const tokenTotals = dailyTokens.reduce((sum, day) => usage(sum.input + day.input, sum.output + day.output, sum.cache + day.cache), usage(0, 0, 0));

export const dashboardTokens = {
  available: true,
  totalInput: tokenTotals.input,
  totalOutput: tokenTotals.output,
  totalCache: tokenTotals.cache,
  total: tokenTotals.total,
  unsupportedAgents: [],
  daily: dailyTokens,
  byEmployee: [
    { employeeId: EMPLOYEE, ...usage(2_410_000, 596_000, 9_820_000), sessionCount: 112 },
    { employeeId: "marcus", ...usage(1_930_000, 471_000, 8_140_000), sessionCount: 94 },
    { employeeId: "priya", ...usage(1_520_000, 344_000, 6_310_000), sessionCount: 71 },
    { employeeId: "jonas", ...usage(1_010_000, 252_000, 4_220_000), sessionCount: 45 },
  ],
  recentSessions: sessions.slice(0, 6).map((item, index) => ({ sessionId: item.id, employeeId: EMPLOYEE, taskGoal: item.title, updatedAt: item.updatedAt, ...usage(18_420 + index * 3_100, 3_960 + index * 540, 96_300 + index * 11_000) })),
};

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

function skill({ id, name, displayName, description, visibility = "org", revision, files, grantedAgentIds, days }) {
  const revisions = Array.from({ length: revision }, (_, index) => ({
    id: `${id}_rev_${revision - index}`, revision: revision - index, bytes: 4_200 + (revision - index) * 380,
    manifestSha256: `${(revision - index).toString(16).padStart(2, "0")}c4e1a97b3d5f08`.padEnd(64, "a"),
    createdAt: ago((days + index * 6) * DAY), createdByEmployeeId: EMPLOYEE,
    note: index === 0 ? "Tightened the verification steps" : index === revision - 1 ? "First version" : "Clarified edge cases",
  }));
  return {
    id, ownerEmployeeId: EMPLOYEE, namespace: "acme", name, slug: name, displayName, description, visibility, source: "authored",
    currentRevisionId: revisions[0].id, stableRevisionId: revisions[0].id,
    createdAt: ago((days + revision * 6) * DAY), updatedAt: ago(days * DAY),
    grantedAgentCount: grantedAgentIds.length, assignmentCount: 0,
    revisions,
    files: files.map(([path, bytes], index) => ({ path, bytes, sha256: `${index}f3a9c`.padEnd(64, "b") })),
    grantedAgentIds,
    assignments: [],
  };
}

export const skills = [
  skill({ id: "skill_billing_runbook", name: "billing-runbook", displayName: "Billing runbook", description: SKILL_BILLING.description, revision: 4, days: 2, grantedAgentIds: ["agent_aria", "agent_cascade"],
    files: [["SKILL.md", 3_140], ["references/export-pipeline.md", 5_860], ["references/ledger-schema.md", 4_410], ["scripts/verify_export.sh", 920]] }),
  skill({ id: "skill_review_checklist", name: "review-checklist", displayName: "Review checklist", description: SKILL_REVIEW.description, revision: 2, days: 6, grantedAgentIds: ["agent_cascade"],
    files: [["SKILL.md", 2_280], ["references/concurrency.md", 3_900]] }),
  skill({ id: "skill_release_notes", name: "release-notes", displayName: "Release notes", description: SKILL_RELEASE.description, revision: 3, days: 9, grantedAgentIds: ["agent_aria"],
    files: [["SKILL.md", 1_960], ["templates/notes.md", 1_120]] }),
  skill({ id: "skill_incident_report", name: "incident-report", displayName: "Incident report", description: "Write a blameless incident report from a timeline and a set of graphs.", visibility: "private", revision: 1, days: 14, grantedAgentIds: [],
    files: [["SKILL.md", 2_050]] }),
];

export const SKILL_MD = [
  "---",
  "name: billing-runbook",
  "description: How the billing pipeline is laid out, and how to verify a change to it.",
  "---",
  "",
  "# Billing runbook",
  "",
  "Use this skill before changing anything under `billing/`.",
  "",
  "## Layout",
  "",
  "- `billing/export/` — the export job; one worker claims one invoice batch.",
  "- `billing/ledger/` — reconciliation against the ledger export.",
  "",
  "## Verify a change",
  "",
  "1. Run `pytest tests/billing -q`.",
  "2. Run `scripts/verify_export.sh` against the staging tenant.",
  "3. Note the rollback step in the pull request.",
  "",
].join("\n");

/* ------------------------------------------------------------------ */
/* Workspace briefs (agent, team, and project activity panes)          */
/* ------------------------------------------------------------------ */

function brief(params) {
  const teamId = params.get("teamId") ?? undefined;
  const projectId = params.get("projectId") ?? undefined;
  const agentId = params.get("agentId") ?? undefined;
  const inScope = (item) => {
    if (teamId) return (item.teamId ?? item.assignedTeamId) === teamId;
    if (projectId) return item.projectId === projectId;
    if (agentId) return (item.ownerAgentId ?? item.assignedAgentId) === agentId || item.participantAgentIds?.includes(agentId);
    return true;
  };
  const scopedSessions = sessions.filter(inScope);
  const scopedTasks = tasks.filter((item) => inScope(item) && item.status !== "done");
  const activeRuns = nodes[0].activeRuns.filter((run) => (agentId
    ? run.logicalAgentId === agentId
    : scopedSessions.some((item) => item.id === run.sessionId)));
  const artifacts = scopedSessions.some((item) => item.id === HERO_ID)
    ? heroArtifacts.map((artifact) => ({ ...artifact, sessionId: HERO_ID, sessionTitle: heroSummary.title, taskGoal: heroSummary.taskGoal, ownerEmployeeId: EMPLOYEE, sessionUpdatedAt: heroSummary.updatedAt }))
    : [];
  const active = (status) => status === "running" || status === "waiting_for_human";
  return {
    employeeId: EMPLOYEE,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    workspacePath: WORKSPACE_ROOT,
    nodes,
    activeRuns,
    sessions: scopedSessions,
    tasks: scopedTasks,
    artifacts,
    metrics: {
      nodeCount: nodes.length,
      activeRunCount: activeRuns.length,
      sessionCount: scopedSessions.length,
      activeSessionCount: scopedSessions.filter((item) => active(item.status)).length,
      taskCount: scopedTasks.length,
      activeTaskCount: scopedTasks.filter((item) => !["done", "backlog"].includes(item.status)).length,
      artifactCount: artifacts.length,
    },
    generatedAt: ago(0),
  };
}

function workspaceFiles(extra) {
  const entry = (name, kind, bytes, minutes) => ({ name, path: name, kind, ...(bytes ? { bytes } : {}), updatedAt: ago(minutes * MINUTE) });
  return {
    ...extra, scope: "shared", source: "live", nodeId: MACBOOK_ID, path: "", exists: true, generatedAt: ago(0),
    entries: [
      entry("billing", "directory", null, 9), entry("docs", "directory", null, 9), entry("tests", "directory", null, 9),
      entry("scripts", "directory", null, 2 * 24 * 60), entry("README.md", "file", 3_412, 6 * 24 * 60),
      entry("pyproject.toml", "file", 1_288, 8 * 24 * 60), entry("CHANGELOG.md", "file", 9_764, 30 * 60),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/* Anything not enumerated below answers with every list key present and
   empty, so an endpoint this file does not know about renders an empty
   state instead of crashing the surface. */
const FALLBACK = {
  sessions: [], tasks: [], agents: [], teams: [], projects: [], nodes: [], sandboxes: [], skills: [],
  employees: [], integrations: [], artifacts: [], events: [], runs: [], entries: [], produced: [],
};

const byId = (items, id) => items.find((item) => item.id === id);

export function currentUser(language) {
  return {
    id: "user_ada", username: "ada", displayName: "Ada Chen", email: "ada@acme.example", role: "admin",
    employeeId: EMPLOYEE, theme: "dark", language, effectiveMaxLocalComputers: 3, localComputerCount: 1,
  };
}

/** The JSON body for one GET, or `undefined` when the path is not enumerated. */
export function routeBody(pathname, params, language) {
  const path = pathname.replace(/^\/api\/v1/, "");
  const [, head, id, tail, leaf] = path.split("/");

  if (path === "/auth/me") return { authenticated: true, user: currentUser(language) };
  if (path === "/auth/status") return { bootstrapped: true, authenticated: true };

  if (path === "/threads") return { sessions };
  if (head === "threads" && id && !tail) return id === HERO_ID ? hero : byId(sessions, id);

  if (path === "/tasks") return { flowPolicy: { wipLimit: 5, scope: "employee" }, tasks };
  if (head === "tasks" && id && !tail) return { ...byId(tasks, id), events: [], activity: [] };
  if (head === "tasks" && tail === "runs") return { taskId: id, runs: [] };
  if (head === "tasks" && tail === "events") return { events: [] };
  if (head === "tasks" && tail === "artifacts") return { taskId: id, artifacts: [] };
  if (head === "tasks" && tail === "workspace" && leaf === "files") return workspaceFiles({ taskId: id, workspaceLayout: "task" });

  if (path === "/agents") return { agents };
  if (head === "agents" && id) return { agent: byId(agents, id) };
  if (path === "/teams") return { teams };
  if (head === "teams" && id) return { team: byId(teams, id) };

  if (path === "/projects") return { projects };
  if (head === "projects" && id && !tail) return { project: byId(projects, id) };
  if (head === "projects" && tail === "workspace" && leaf === "files") return workspaceFiles({ projectId: id });

  if (path === "/daemon-nodes") return { nodes };
  if (path === "/sandboxes") return { sandboxes: nodes };
  if (path === "/workspace/brief") return brief(params);

  if (path === "/skills") return { skills: skills.map(({ revisions, files, grantedAgentIds, assignments, ...record }) => record) };
  if (head === "skills" && id && !tail) return byId(skills, id);
  if (head === "skills" && tail === "files") return { path: params.get("path"), bytes: SKILL_MD.length, sha256: "0f3a9c".padEnd(64, "b"), binary: false, truncated: false, content: SKILL_MD };

  if (path === "/admin/daemon-nodes") return { nodes: fleet };
  if (path === "/admin/managed-nodes") return { nodes: managedNodes };
  if (path === "/admin/employees") return { employees };
  if (path === "/admin/agents") return { agents };
  if (path === "/admin/settings") return { settings: { maxLocalComputersPerEmployee: 3, maxTaskRounds: 3, updatedAt: ago(12 * DAY) }, capabilities: { employeeEdits: true } };
  if (path === "/admin/dashboard/sessions") return dashboardSessions;
  if (path === "/admin/dashboard/tokens") return dashboardTokens;

  return undefined;
}

export { FALLBACK, HERO_ID };
