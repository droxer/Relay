import { expect, test, type Page } from "@playwright/test";

/* A task thread. Its status changes (Ready, started, sent to review,
   accepted) used to be centred dividers between the turns; they now open
   from the header's task chip, and work waiting on a person docks a one-line
   bar on the composer. */
const at = (minute: number) => `2026-10-18T08:${String(minute).padStart(2, "0")}:00.000Z`;
const computerId = "device:u:host";
const agent = {
  id: "agt_james", displayName: "James", executorKind: "claude", defaultRole: "implementer", supervisorUserId: "u",
  enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null, createdAt: at(0), updatedAt: at(0),
  placements: [{ id: "placement-james", agentId: "agt_james", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
};
const node = { id: "node", userId: "u", workspaceId: "host", computerId, name: "Relay Dev", activeRuns: [],
  online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces", "task-workspaces"] };
const said = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Harness engineering is the practice of building the environment an agent works in: tools, context, permissions, and checks." }] } });
const session = {
  id: "harness-thread", title: "What is harness engineering", taskGoal: "What is harness engineering", workspacePath: "/workspace",
  computerId, daemonNodeId: "node", ownerUserId: "u", ownerAgentId: agent.id, participants: ["human"], status: "completed", phase: "completed",
  createdAt: at(54), updatedAt: at(55),
  agentRuns: [{ id: "run-1", agent: "claude", logicalAgentId: agent.id, status: "completed", startedAt: at(54), completedAt: at(54), artifactIds: [] }],
  artifacts: [], decisions: [],
  events: [
    { id: "e1", type: "agent.started", sessionId: "harness-thread", timestamp: at(54), runId: "run-1", agent: "claude", logicalAgentId: agent.id },
    { id: "e2", type: "agent.output", sessionId: "harness-thread", timestamp: at(54), runId: "run-1", agent: "claude", stream: "stdout", text: `${said}\n` },
    { id: "e3", type: "agent.completed", sessionId: "harness-thread", timestamp: at(54), runId: "run-1", agent: "claude", status: "completed", exitCode: 0 },
  ],
  eventCount: 3, artifactCount: 0, runCount: 1,
};
const task = {
  id: "harness-task", number: 3, title: "What is harness engineering", description: "", priority: "normal", status: "done",
  isRoutine: false, linkedSessionIds: [session.id], ownerUserId: "u", assignedAgentId: agent.id, createdAt: at(53), updatedAt: at(55),
  events: [], activity: [],
};
const taskEvents = [
  { id: "t1", type: "task.status", taskId: task.id, timestamp: "2026-10-18T08:53:59.000Z", status: "assigned", actorUserId: "u" },
  { id: "t2", type: "task.status", taskId: task.id, timestamp: "2026-10-18T08:54:01.000Z", status: "running" },
  { id: "t3", type: "task.status", taskId: task.id, timestamp: "2026-10-18T08:54:50.000Z", status: "review" },
  { id: "t4", type: "task.status", taskId: task.id, timestamp: at(55), status: "done", actorUserId: "u" },
];

type Theme = "light" | "dark";

async function serve(page: Page, theme: Theme, status: "done" | "review") {
  const current = { ...task, status };
  const events = status === "done" ? taskEvents : taskEvents.slice(0, 3);
  const patches: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { sessions: [session], agents: [agent], teams: [], tasks: [current], nodes: [node], projects: [], sandboxes: [], skills: [], files: [], entries: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme, language: "en" } };
    if (path.endsWith(`/threads/${session.id}`)) body = session;
    if (path.endsWith(`/threads/${session.id}/events`)) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (path.endsWith(`/tasks/${task.id}`)) {
      if (request.method() === "PATCH") patches.push(JSON.parse(request.postData() ?? "{}"));
      body = current;
    }
    if (path.endsWith("/runs")) body = { taskId: task.id, runs: [] };
    if (path.endsWith(`/tasks/${task.id}/events`)) body = { events };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return patches;
}

for (const theme of ["dark", "light"] as const) {
  test(`a task thread keeps its status moves behind the header chip (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await serve(page, theme, "done");
    await page.goto(`/threads/${session.id}`);

    const transcript = page.getByRole("log");
    await expect(transcript).toContainText("Harness engineering is the practice");
    await expect(transcript).not.toContainText("Sent to review");
    // Nothing waits on a person, so nothing docks on the composer.
    await expect(page.locator(".task-action-bar")).toHaveCount(0);

    await page.getByRole("button", { name: /#3/ }).click();
    const status = page.getByRole("region", { name: "Task status" });
    await expect(status.locator(".task-status-now")).toHaveText("Completed");
    await expect(status.getByRole("listitem")).toHaveText([
      /Ready to start.*by you/,
      /Work started\s*\d/,
      /Sent to review\s*\d/,
      /Accepted.*by you/,
    ]);
    await expect(status.getByRole("link", { name: "#3" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`task-status-popover-${theme}.png`) });
  });
}

test("work in review docks an accept bar on the composer", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const patches = await serve(page, "dark", "review");
  await page.goto(`/threads/${session.id}`);

  const bar = page.locator(".task-action-bar");
  await expect(bar).toContainText("#3 is ready for your review.");
  await bar.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  await page.screenshot({ path: testInfo.outputPath("task-action-bar-review.png") });

  await bar.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByRole("textbox").first()).toBeFocused();
  await bar.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => patches).toEqual([{ status: "done" }]);
});
