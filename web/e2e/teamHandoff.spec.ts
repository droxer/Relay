import { expect, test, type Page } from "@playwright/test";

type Stage = "gap" | "staged";

// A build/review round where the builder has finished. "gap" is the quiet
// window before the reviewer's run exists; "staged" is the reviewer's run
// dispatched but silent (queued, booting).
async function fixture(page: Page, stage: Stage, theme: "light" | "dark" = "light") {
  const stamp = "2026-09-27T10:00:00Z";
  const finished = new Date(Date.now() - 12_000).toISOString();
  const computerId = "device:alice:host";
  const agents = [["ada", "Ada", "implementer"], ["rex", "Rex", "reviewer"]].map(([id, displayName, defaultRole]) => ({
    id, displayName, executorKind: "claude", defaultRole, supervisorEmployeeId: "alice",
    enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null,
    placements: [{ id: `placement-${id}`, agentId: id, computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp,
  }));
  const team = { id: "delivery", name: "Delivery", ownerEmployeeId: "alice", leadAgentId: "ada",
    memberAgentIds: ["ada", "rex"], members: agents, lead: agents[0], enabled: true, deletedAt: null,
    collaborationStyle: "build_review", memberConfigs: {}, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp };
  const round = { roundId: "round", collaborationId: "c", source: "thread", purpose: "accomplish", strategy: "room",
    style: "build_review", address: { kind: "room" }, completionPolicy: "all_required",
    assignments: [
      { assignmentId: "a-build", agentId: "ada", role: "implementer" },
      { assignmentId: "a-review", agentId: "rex", role: "reviewer" },
    ] };
  const reply = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Added the retry guard and a regression test." }] } });
  const events: unknown[] = [
    { id: "e1", type: "collaboration.round.started", sessionId: "handoff", timestamp: stamp, manifest: round },
    { id: "e2", type: "agent.started", sessionId: "handoff", timestamp: stamp, runId: "run-ada", assignmentId: "a-build", agent: "claude", logicalAgentId: "ada", role: "implementer" },
    { id: "e3", type: "agent.output", sessionId: "handoff", timestamp: stamp, runId: "run-ada", agent: "claude", stream: "stdout", text: `${reply}\n` },
    { id: "e4", type: "agent.completed", sessionId: "handoff", timestamp: finished, runId: "run-ada", assignmentId: "a-build", agent: "claude", status: "completed", exitCode: 0 },
  ];
  const agentRuns: unknown[] = [
    { id: "run-ada", assignmentId: "a-build", agent: "claude", logicalAgentId: "ada", role: "implementer", status: "completed", startedAt: stamp, completedAt: finished, artifactIds: [] },
  ];
  if (stage === "staged") {
    events.push({ id: "e5", type: "agent.started", sessionId: "handoff", timestamp: finished, runId: "run-rex", assignmentId: "a-review", agent: "claude", logicalAgentId: "rex", role: "reviewer" });
    agentRuns.push({ id: "run-rex", assignmentId: "a-review", agent: "claude", logicalAgentId: "rex", role: "reviewer", status: "running", startedAt: finished, artifactIds: [] });
  }
  const session = { id: "handoff", title: "Retry guard", taskGoal: "Add a retry guard to the uploader", teamId: team.id,
    ownerEmployeeId: "alice", ownerAgentId: "ada", daemonNodeId: "node", computerId,
    workspacePath: "/workspace", status: "running", phase: "team", participants: ["human"],
    activeRoundId: "round", collaborationRounds: [round], agentRuns, artifacts: [], decisions: [], events,
    eventCount: events.length, artifactCount: 0, runCount: agentRuns.length, createdAt: stamp, updatedAt: finished };
  const node = { id: "node", employeeId: "alice", workspaceId: "host", computerId, name: "Computer", activeRuns: [],
    online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces", "work-results"] };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [session], agents, teams: [team], tasks: [], nodes: [node], projects: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", employeeId: "alice", username: "alice", role: "employee", theme, language: "en" } };
    if (path.endsWith("/threads/handoff")) body = session;
    if (path.endsWith("/threads/handoff/events")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`team handoff gap names the incoming teammate (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fixture(page, "gap", theme);
    await page.goto("/threads/handoff");
    const cue = page.locator(".team-handoff");
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute("role", "status");
    await expect(cue).toContainText("Ada finished · handing off to Rex");
    await expect(cue.locator(".team-handoff-elapsed")).toHaveText(/^\d+s$/);
    await page.screenshot({ path: `/tmp/relay-team-handoff-gap-${theme}.png` });
  });
}

test("a staged handoff turn says whose work it picks up", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, "staged");
  await page.goto("/threads/handoff");
  await expect(page.locator(".team-handoff")).toHaveCount(0);
  const turn = page.locator(".msg-agent").filter({ hasText: "Rex" });
  await expect(turn.locator(".agent-stream-activity")).toHaveText("Picking up from Ada…");
  expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "/tmp/relay-team-handoff-staged.png" });
});
