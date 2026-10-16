import { expect, test, type Page } from "@playwright/test";

/* A task whose agent stopped to ask a question. Before this surface the
   thread looked finished and the task page only said "input is needed", so
   nobody could tell what to answer or where. */
const stamp = "2026-10-10T09:00:00.000Z";
const QUESTION = "Which vault holds the staging signing key — ops or platform?";
const computerId = "device:u:host";
const reviewer = {
  id: "agt_reviewer", displayName: "Reviewer", executorKind: "claude", defaultRole: "reviewer", supervisorUserId: "u",
  enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null, createdAt: stamp, updatedAt: stamp,
  placements: [{ id: "placement-reviewer", agentId: "agt_reviewer", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
};
const node = { id: "node", userId: "u", workspaceId: "host", computerId, name: "Computer", activeRuns: [],
  online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces", "task-workspaces", "round-result"] };
const said = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Both vaults hold a key named `staging-signing`, and they differ. Rotating the wrong one would break deploys, so I stopped before touching either." }] } });
const session = {
  id: "keys-thread", title: "Rotate the staging keys", taskGoal: "Rotate the staging signing keys", workspacePath: "/workspace",
  computerId, daemonNodeId: "node", ownerUserId: "u", ownerAgentId: reviewer.id, participants: ["human"], status: "completed", phase: "completed",
  finalOutcome: `The round reported it is blocked. ${QUESTION}`, workOutcome: "blocked",
  createdAt: stamp, updatedAt: stamp,
  agentRuns: [{ id: "run-1", agent: "claude", logicalAgentId: reviewer.id, status: "completed", startedAt: stamp, completedAt: stamp, artifactIds: [] }],
  artifacts: [], decisions: [], activeRoundId: "asking-round",
  collaborationRounds: [{
    roundId: "asking-round", collaborationId: "asking-work", source: "task", purpose: "accomplish",
    strategy: "direct", address: { kind: "room" },
    assignments: [{ assignmentId: "asking-assignment", agentId: reviewer.id, mode: "action" }],
    workScope: { kind: "task", taskId: "rotate-keys" },
  }],
  events: [
    { id: "e1", type: "agent.started", sessionId: "keys-thread", timestamp: stamp, runId: "run-1", agent: "claude", logicalAgentId: reviewer.id },
    { id: "e2", type: "agent.output", sessionId: "keys-thread", timestamp: stamp, runId: "run-1", agent: "claude", stream: "stdout", text: `${said}\n` },
    { id: "e3", type: "agent.completed", sessionId: "keys-thread", timestamp: stamp, runId: "run-1", agent: "claude", status: "completed", exitCode: 0 },
  ],
  eventCount: 3, artifactCount: 0, runCount: 1,
};
const task = {
  id: "rotate-keys", number: 12, title: "Rotate the staging keys", description: "", priority: "high", status: "waiting_for_human",
  waitingReason: `The round reported it is blocked. ${QUESTION}`, isRoutine: false,
  linkedSessionIds: [session.id], ownerUserId: "u", assignedAgentId: reviewer.id, createdAt: stamp, updatedAt: stamp, events: [], activity: [],
};

const BLOCKED_ROUND_PREAMBLE = "The round reported it is blocked.";

/** The wait as the backend projects it onto a task response (`task_awaiting`
 *  in backend/relay/collaboration/awaiting.py); the web renders it as is. A
 *  test that needs the backend's legacy rewording passes `awaiting` itself. */
function projectedWait(waitingTask: Record<string, unknown>, thread: Record<string, unknown>, taskScoped: boolean) {
  const reason = String(waitingTask.waitingReason ?? "");
  const asked = reason.startsWith(BLOCKED_ROUND_PREAMBLE);
  return {
    questionId: "wait-1",
    kind: asked ? "question" : "check",
    text: asked ? reason.slice(BLOCKED_ROUND_PREAMBLE.length).trim() || null : reason,
    options: asked ? (thread.inputOptions as string[] | undefined) ?? [] : [],
    notes: [],
    // A legacy linked thread is not where the task waits.
    sessionId: taskScoped ? thread.id : "elsewhere",
    resumable: true,
    ...(waitingTask.awaiting as Record<string, unknown> | undefined),
  };
}

async function serve(page: Page, theme: "light" | "dark", taskScoped = true, overrides: Partial<typeof session> & Record<string, unknown> = {}, taskOverrides: Record<string, unknown> = {}): Promise<string[]> {
  const sent: string[] = [];
  const thread = { ...(taskScoped ? session : { ...session, activeRoundId: undefined, collaborationRounds: [] }), ...overrides };
  const merged = { ...task, ...taskOverrides };
  const waitingTask = { ...merged, awaiting: projectedWait(merged, thread, taskScoped) };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { sessions: [thread], agents: [reviewer], teams: [], tasks: [waitingTask], nodes: [node], projects: [], sandboxes: [], skills: [], files: [], entries: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme, language: "en" } };
    if (path.endsWith(`/threads/${session.id}`)) body = thread;
    if (path.endsWith(`/threads/${session.id}/events`)) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (path.endsWith(`/tasks/${task.id}`)) body = waitingTask;
    if (path.endsWith("/runs")) body = { taskId: task.id, runs: [] };
    if (path.endsWith(`/tasks/${task.id}/events`)) body = { events: [] };
    if (request.method() === "POST" && path.endsWith(`/threads/${session.id}/messages`)) {
      sent.push(JSON.parse(request.postData() ?? "{}").text);
      body = { ...thread, status: "running" };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return sent;
}

test("a legacy linked thread does not promise to resume a task", async ({ page }) => {
  await serve(page, "light", false);
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer needs your answer" });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(QUESTION);
  await expect(prompt).toContainText("Your reply continues the work.");
  await expect(prompt).not.toContainText("Your reply resumes");
  await expect(prompt.getByRole("link", { name: "Open task #12" })).toHaveCount(0);
});

test("an offered answer is one click, and sends as the reply", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sent = await serve(page, "light", true, { inputOptions: ["Ops vault", "Platform vault"] });
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer needs your answer" });
  const answers = prompt.getByRole("list", { name: "Answers" });
  await expect(answers.getByRole("button")).toHaveText(["1Ops vault", "2Platform vault"]);
  await expect(prompt).toContainText("Pick one to resume #12, or write your own answer.");
  await prompt.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  await answers.getByRole("button", { name: "Platform vault" }).hover();
  await prompt.screenshot({ path: testInfo.outputPath("awaiting-choices.png") });
  await answers.getByRole("button", { name: "Platform vault" }).click();
  await expect.poll(() => sent).toEqual(["Platform vault"]);
});

test("a gate stop explains itself plainly and offers next steps", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const gate = "Work needs attention. Work 6fc1d579-ef85-4b54-9ceb-444985f8ea6c is not accepted: missing.";
  const sent = await serve(page, "dark", true, { finalOutcome: gate }, {
    waitingReason: gate,
    awaiting: { text: "A required step ended without reporting what it did." },
  });
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer stopped before finishing" });
  await expect(prompt.locator("blockquote")).toHaveText("A required step ended without reporting what it did.");
  await expect(prompt).not.toContainText("6fc1d579");
  await prompt.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  await prompt.screenshot({ path: testInfo.outputPath("awaiting-check.png") });
  await prompt.getByRole("button", { name: "Keep going and report back" }).click();
  await expect.poll(() => sent).toEqual([
    "Please continue the work. When you stop, report what you did and how you checked it.",
  ]);
});

test("asking for status is a question, not a task round", async ({ page }) => {
  const gate = "The work can't be accepted yet. A required step failed to run.";
  await serve(page, "light", true, { finalOutcome: gate }, { waitingReason: gate });
  const bodies: Array<{ text?: string; intent?: string }> = [];
  // Registered after serve(), so it answers the message POST first.
  await page.route(`**/threads/${session.id}/messages`, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...session, status: "running" }) });
  });
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer stopped before finishing" });
  await expect(prompt).toContainText("Asking for status leaves it waiting for you.");
  await prompt.getByRole("button", { name: "Tell me what's done and what's left" }).click();
  await expect.poll(() => bodies.map((body) => body.intent)).toEqual(["discuss"]);
});

test("an offered answer containing an unknown mention sends literally", async ({ page }) => {
  const sent = await serve(page, "light", true, { inputOptions: ["@Unknown deploy", "Staging"] });
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer needs your answer" });
  await prompt.getByRole("button", { name: "@Unknown deploy" }).click();
  await expect.poll(() => sent).toEqual(["@Unknown deploy"]);
});

test("an unstructured list stays in the question with every item visible", async ({ page }) => {
  const question = "Please provide these details:\n" + Array.from({ length: 7 }, (_, i) => `- Detail ${i + 1}`).join("\n");
  const reason = `The round reported it is blocked. ${question}`;
  await serve(page, "light", true, { finalOutcome: reason }, { waitingReason: reason });
  await page.goto(`/threads/${session.id}`);
  const prompt = page.getByRole("region", { name: "Reviewer needs your answer" });
  await expect(prompt.locator("blockquote")).toHaveText(question);
  await expect(prompt.getByRole("list", { name: "Answers" })).toHaveCount(0);
  await expect(prompt.getByRole("button", { name: "Reply", exact: true })).toBeEnabled();
});

for (const theme of ["light", "dark"] as const) {
  for (const mobile of [false, true]) {
    test(`a waiting thread asks its question at the composer (${theme}, ${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      const sent = await serve(page, theme);
      await page.goto(`/threads/${session.id}`);
      const prompt = page.getByRole("region", { name: "Reviewer needs your answer" });
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText(QUESTION);
      await expect(prompt).not.toContainText("The round reported");
      await expect(prompt).toContainText("Your reply resumes #12.");
      await expect(page.getByPlaceholder("Answer Reviewer…")).toBeVisible();
      // Measure the resting position, not a frame of the dock-in motion.
      await prompt.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
      const [slip, card] = await Promise.all([
        prompt.boundingBox(),
        page.locator(".composer-input-wrap").boundingBox(),
      ]);
      // Docked: the slip's bottom edge sits on the card's top edge.
      expect(Math.abs(slip!.y + slip!.height - card!.y)).toBeLessThanOrEqual(2);
      expect(slip!.x).toBeGreaterThanOrEqual(0);
      expect(slip!.x + slip!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
      await page.screenshot({ path: testInfo.outputPath(`awaiting-thread-${theme}-${mobile ? "mobile" : "desktop"}.png`) });

      await prompt.getByRole("button", { name: "Reply" }).click();
      await expect(page.getByPlaceholder("Answer Reviewer…")).toBeFocused();
      await page.keyboard.type("Use the ops vault.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => sent).toEqual(["Use the ops vault."]);
    });
  }

  test(`the waiting task quotes the question and leads with reply (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await serve(page, theme);
    await page.goto(`/tasks/${task.id}`);
    const panel = page.getByRole("region", { name: "Next steps" });
    await expect(panel).toContainText("Your input is needed");
    await expect(panel.locator("blockquote")).toHaveText(QUESTION);
    const reply = panel.getByRole("link", { name: "Reply in thread" });
    // The one filled control in the panel: answering is the way forward.
    const fill = await reply.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await panel.screenshot({ path: testInfo.outputPath(`awaiting-task-${theme}.png`) });
  });
}
