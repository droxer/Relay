import { expect, test, type Page } from "@playwright/test";

// A solo thread whose agent was stopped mid-run (an outage, a lost lease)
// after its runtime reported the conversation it ran in.
async function fixture(page: Page, runtimeSessionId?: string) {
  const stamp = "2026-10-11T10:00:00Z";
  const computerId = "device:alice:host";
  const agent = {
    id: "ada", displayName: "Ada", executorKind: "claude", defaultRole: "implementer", supervisorEmployeeId: "alice",
    enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null,
    placements: [{ id: "placement-ada", agentId: "ada", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp,
  };
  const reply = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Migrated two of the five tables." }] } });
  const events = [
    { id: "e1", type: "agent.started", sessionId: "resume", timestamp: stamp, runId: "run-ada", agent: "claude", logicalAgentId: "ada", role: "implementer" },
    { id: "e2", type: "agent.output", sessionId: "resume", timestamp: stamp, runId: "run-ada", agent: "claude", stream: "stdout", text: `${reply}\n` },
    { id: "e3", type: "agent.completed", sessionId: "resume", timestamp: stamp, runId: "run-ada", agent: "claude", status: "cancelled", exitCode: 130,
      ...(runtimeSessionId ? { runtimeSessionId } : {}) },
  ];
  const session = { id: "resume", title: "Billing migration", taskGoal: "Migrate the billing tables",
    ownerEmployeeId: "alice", ownerAgentId: "ada", daemonNodeId: "node", computerId,
    workspacePath: "/workspace", status: "cancelled", phase: "cancelled", participants: ["human"], collaborationRounds: [],
    agentRuns: [{ id: "run-ada", agent: "claude", logicalAgentId: "ada", status: "cancelled", startedAt: stamp, completedAt: stamp, artifactIds: [],
      ...(runtimeSessionId ? { runtimeSessionId } : {}) }],
    artifacts: [], decisions: [], events, eventCount: events.length, artifactCount: 0, runCount: 1, createdAt: stamp, updatedAt: stamp };
  const node = { id: "node", employeeId: "alice", workspaceId: "host", computerId, name: "Computer", activeRuns: [],
    online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces", "agent-resume"] };
  const posted: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { sessions: [session], agents: [agent], teams: [], tasks: [], nodes: [node], projects: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", employeeId: "alice", username: "alice", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/threads/resume")) body = session;
    if (path.endsWith("/threads/resume/events")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/recoveries")) {
      posted.push(JSON.parse(request.postData() ?? "{}"));
      body = session;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return posted;
}

test("an interrupted turn can be resumed in the agent's own conversation", async ({ page }) => {
  const posted = await fixture(page, "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d");
  await page.goto("/threads/resume");
  const turn = page.locator(".msg-agent").filter({ hasText: "Migrated two of the five tables" });
  await turn.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ kind: "rerun", targetAgentId: "ada", resume: true });
});

test("a turn without a recorded conversation offers only retry", async ({ page }) => {
  await fixture(page);
  await page.goto("/threads/resume");
  const turn = page.locator(".msg-agent").filter({ hasText: "Migrated two of the five tables" });
  await expect(turn.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(turn.getByRole("button", { name: "Resume" })).toHaveCount(0);
});
