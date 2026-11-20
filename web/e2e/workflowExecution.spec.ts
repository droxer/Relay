import { expect, test, type Page } from "@playwright/test";
import type { WorkflowRun, WorkflowStepDefinition } from "relay-core";

const stamp = "2026-11-18T00:00:00Z";
const currentStep = "核对发布清单并确认所有必需的回归用例都已通过 · Verify the release checklist before continuing";
const lastStep = "Record the release";
const lastLine = "End of recorded output";

function makeRun(id: string, status: WorkflowRun["status"], startedAt: string): WorkflowRun {
  const workflowSteps: WorkflowStepDefinition[] = Array.from({ length: 20 }, (_, index) => ({
    id: `step-${index}`,
    name: index === 19 ? lastStep : index === 18 ? currentStep : `Release step ${index + 1}`,
    agentId: "builder",
    instructions: "Perform the release check.",
    acceptanceCriteria: [],
    requiresApproval: index === 18,
  }));
  const assignments = workflowSteps.map((step, index) => ({
    workflowRunId: id, workflowStepId: step.id, workflowAttempt: 1,
    assignmentId: `${id}-attempt-${index}`, workItemId: `${id}-item-${index}`,
    workOwnerAgentId: step.agentId, workObjective: step.instructions, awaitApproval: step.requiresApproval,
    expectedOutputs: [], acceptanceCriteria: [],
  }));
  return {
    workflowRunId: id, status, startedAt, currentIndex: status === "completed" ? 20 : 18,
    revision: 18, teamSnapshot: { id: "team", name: id, workflowSteps }, assignments,
    gateDecisions: [],
    attemptResults: status === "awaiting_approval" ? [{
      ...assignments[17], runId: "agent-run", commandId: "command", timestamp: startedAt, status: "succeeded",
      outputs: { "Verification log": `${"release-check-".repeat(40)}\n${"Checked deployment status\n".repeat(35)}${lastLine}` },
    }] : [],
  };
}

async function fixture(page: Page, language: string, assignedWorkflowId?: string) {
  const runs = [
    makeRun("First release", "cancelled", "2026-11-18T01:00:00Z"),
    makeRun("Earlier release", "completed", "2026-11-18T02:00:00Z"),
    makeRun("Release checklist", "awaiting_approval", "2026-11-18T03:00:00Z"),
  ];
  const sessions = runs.map((run, index) => ({
    id: `release-${index}`, title: "Release Thread", taskGoal: "Ship the release", ownerUserId: "alice",
    ownerAgentId: "builder", projectId: "release", workspacePath: "/workspace",
    status: index === 2 ? "running" : run.status, phase: "created", participants: ["human"],
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
    workflowRuns: [run], activeWorkflowRunId: run.workflowRunId,
    eventCount: 0, artifactCount: 0, runCount: 0, createdAt: run.startedAt, updatedAt: run.startedAt,
  }));
  const task = {
    id: "ship", title: "Ship the release", description: "", status: "waiting_for_human", priority: "normal",
    projectId: "release", ownerUserId: "alice", isRoutine: false, assignedWorkflowId,
    linkedSessionIds: sessions.map(session => session.id), activity: [], events: [], createdAt: stamp, updatedAt: stamp,
    attention: { code: "workflow_blocked" as string | undefined },
  };
  const project = { id: "release", name: "Release", ownerUserId: "alice", computerId: "device:alice:host", enabled: true, members: [], version: 1, createdAt: stamp, updatedAt: stamp };
  const agent = { id: "builder", displayName: "Release Builder", executorKind: "codex", enabled: true, placements: [], skills: [] };

  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions, tasks: [task], projects: [project], agents: [agent], teams: [], nodes: [], workflows: [], skills: [] };
    const session = sessions.find(item => path.endsWith(`/threads/${item.id}`));
    if (session) body = session;
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "Alice", role: "user", theme: "light", language } };
    if (path.endsWith("/projects/release")) body = { project };
    if (path.endsWith("/tasks/ship")) body = task;
    if (path.endsWith("/tasks/ship/workflow-history")) body = { threads: sessions };
    if (assignedWorkflowId && path.endsWith(`/workflows/${assignedWorkflowId}`)) {
      body = { workflow: { id: assignedWorkflowId, name: "Release workflow definition" } };
    }
    if (path.endsWith("/threads/release-2/workflow-decisions")) {
      const active = sessions[2];
      active.workflowRuns = [{ ...active.workflowRuns[0], status: "ready", revision: 19 }];
      task.status = "running";
      task.attention.code = undefined;
      body = active;
    }
    if (path.endsWith("/events")) body = { events: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    if (path.endsWith("/queue")) body = { messages: [] };
    await route.fulfill({ json: body });
  });
}

test("reads a Task's Workflow by ID only on the Definition tab", async ({ page }) => {
  const workflowReads: string[] = [];
  page.on("request", request => {
    const { pathname } = new URL(request.url());
    if (pathname === "/api/v1/workflows" || pathname.startsWith("/api/v1/workflows/")) workflowReads.push(pathname);
  });
  await fixture(page, "en", "release-plan");
  await page.goto("/projects/release?task=ship&recordTab=activity");
  await expect(page.getByRole("heading", { name: "Current run" })).toBeVisible();
  expect(workflowReads).toEqual([]);
  await page.getByRole("tab", { name: "Definition" }).click();
  await expect(page.getByText("Release workflow definition", { exact: true })).toBeVisible();
  expect(workflowReads).toEqual(["/api/v1/workflows/release-plan"]);
});

test("approves a waiting Workflow Run in Task Activities", async ({ page }) => {
  const initialReads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/workflow-history") || url.searchParams.get("view") === "workflow") {
      initialReads.push(url.pathname);
    }
  });
  await fixture(page, "en");
  await page.goto("/projects/release?task=ship&recordTab=activity");

  const run = page.locator(".record-workflow-run").first();
  const summary = run.locator(".workflow-run-summary");
  await expect(summary.getByText("Waiting for approval", { exact: true })).toBeVisible();
  expect(initialReads).toEqual(["/api/v1/tasks/ship/workflow-history"]);
  await expect(run.getByRole("button", { name: /^Reject\b/ })).toBeVisible();
  const decision = page.waitForRequest(request => request.url().endsWith("/threads/release-2/workflow-decisions"));
  await run.getByRole("button", { name: /^Approve\b/ }).click();

  expect((await decision).postDataJSON()).toEqual({
    kind: "approve", workflowRunId: "Release checklist", workflowStepId: "step-18",
    assignmentId: "Release checklist-attempt-18", workflowAttempt: 1, expectedRevision: 18,
  });
  await expect(summary.getByText("Running", { exact: true })).toBeVisible();
  await expect(run.getByRole("button", { name: /^(Approve|Reject)\b/ })).toHaveCount(0);
});

for (const { width, height, language, labels } of [
  { width: 1280, height: 900, language: "en", labels: { current: "Current run", pending: "Waiting for approval", view: "View run details", steps: "Run steps", close: "Close", approve: "Approve" } },
  { width: 375, height: 812, language: "zh-CN", labels: { current: "当前执行", pending: "等待批准", view: "查看执行详情", steps: "执行步骤", close: "关闭", approve: "批准" } },
]) {
  test(`Workflow execution stays readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, language);
    await page.goto("/projects/release?task=ship&recordTab=activity");

    const summary = page.locator(".record-workflow-run").first();
    await expect(page.getByRole("heading", { name: labels.current })).toBeInViewport();
    for (const text of [currentStep, "Release Builder", labels.pending, /18\/20/]) {
      await expect(summary.locator(".workflow-run-summary").getByText(text)).toBeInViewport();
    }
    const history = page.locator(".record-workflow-history");
    await expect(history.getByRole("article")).toHaveCount(2);
    await expect(history.locator("details[open]")).toHaveCount(0);
    await history.getByText(labels.steps, { exact: true }).first().click();
    await expect(history.locator("details[open]")).toHaveCount(1);
    await expect(history.locator("details[open]").getByText(lastStep)).toBeVisible();

    await summary.getByRole("link").click();
    const trigger = page.getByRole("button", { name: labels.view });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    const scrollRegion = dialog.getByRole("region", { name: labels.steps });
    await expect(dialog.getByRole("heading")).toBeFocused();
    await expect(dialog.locator(".workflow-run-summary").getByText(labels.pending)).toBeInViewport();
    await expect(scrollRegion.locator(".workflow-timeline-step")).toHaveCount(20);
    const scrollable = await scrollRegion.evaluate(region => [region, ...region.querySelectorAll<HTMLElement>("*")]
      .filter(element => ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
      .map(element => element.className));
    expect(scrollable).toEqual(["workflow-run-scroll"]);
    expect(await scrollRegion.evaluate(region => region.scrollWidth - region.clientWidth)).toBeLessThanOrEqual(1);
    const output = scrollRegion.locator("dd").filter({ hasText: lastLine });
    expect(await output.evaluate((element, line) => {
      const text = element.firstChild!;
      const range = document.createRange();
      range.setStart(text, element.textContent!.lastIndexOf(line));
      range.setEndAfter(text);
      const scroller = element.closest(".workflow-run-scroll")!;
      scroller.scrollTop += range.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
      const bounds = range.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom + 1;
    }, lastLine)).toBe(true);
    await scrollRegion.focus();
    await page.keyboard.press("End");
    await expect(scrollRegion.getByText(lastStep)).toBeInViewport();
    await expect(dialog.getByRole("button", { name: labels.close })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    const decision = page.waitForRequest(request => request.url().endsWith("/threads/release-2/workflow-decisions"));
    await page.getByRole("button").filter({ has: page.getByText(labels.approve, { exact: true }) }).click();
    expect((await decision).postDataJSON()).toEqual({
      kind: "approve", workflowRunId: "Release checklist", workflowStepId: "step-18",
      assignmentId: "Release checklist-attempt-18", workflowAttempt: 1, expectedRevision: 18,
    });
  });
}

test("a phone thread keeps room for the transcript beside the workflow progress", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, "en");
  await page.goto("/threads/release-2");

  const progress = page.locator(".chat-panel > .workflow-progress");
  await expect(progress.getByRole("button", { name: "View run details" })).toBeVisible();
  // One summary line plus the current step: the details button rides beside
  // it, so the card stays a band rather than a third of the screen.
  expect((await progress.boundingBox())!.height).toBeLessThanOrEqual(100);
  const log = await progress.evaluate(element => element.nextElementSibling!.getBoundingClientRect().height);
  expect(log).toBeGreaterThanOrEqual(200);
});

test("the workflow ledger survives forced colours and two-digit steps", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await fixture(page, "en");
  await page.goto("/threads/release-2");
  await page.getByRole("button", { name: "View run details" }).click();
  const timeline = page.locator(".workflow-run-dialog .workflow-timeline");
  await expect(timeline.locator(".workflow-timeline-step")).toHaveCount(20);

  // The rail is a border, which forced colours keep; a background is dropped.
  const rail = await timeline.locator(".workflow-timeline-step").first().evaluate(step => {
    const style = getComputedStyle(step, "::before");
    return { drawn: parseFloat(style.borderInlineStartWidth) > 0, style: style.borderInlineStartStyle };
  });
  expect(rail).toEqual({ drawn: true, style: "solid" });

  // Only the step the run stopped at is current, and its band's leading
  // edge is a border too, so the highlight survives forced colours.
  const current = timeline.locator('.workflow-timeline-step[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-state", "waiting");
  await expect(current).toContainText(currentStep);
  const edge = await current.evaluate(step => {
    const style = getComputedStyle(step);
    return { drawn: parseFloat(style.borderInlineStartWidth) > 0, style: style.borderInlineStartStyle };
  });
  expect(edge).toEqual({ drawn: true, style: "solid" });

  // Every number, "20" included, sits inside its ring.
  const overflowing = await timeline.locator(".workflow-step-index").evaluateAll(marks => marks.filter(mark => {
    const range = document.createRange();
    range.selectNodeContents(mark);
    const text = range.getBoundingClientRect();
    const box = mark.getBoundingClientRect();
    return text.left < box.left + 2 || text.right > box.right - 2;
  }).map(mark => mark.textContent));
  expect(overflowing).toEqual([]);
});

test("a task's workflow run keeps a full-size thread link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page, "en");
  await page.goto("/projects/release?task=ship&recordTab=activity");
  const link = page.locator(".record-workflow-actions .record-inline-action").first();
  await expect(link).toBeVisible();
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(24);
});

test.describe("on a phone held in the hand", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the workflow band opens its run as a pulled sheet", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, "en");
    await page.goto("/threads/release-2");

    // The band is the control: its button keeps the name but draws a chevron,
    // and a tap anywhere on the band opens the run.
    const progress = page.locator(".chat-panel > .workflow-progress");
    const trigger = progress.getByRole("button", { name: "View run details" });
    await expect(trigger).toBeVisible();
    await expect(progress.locator(".workflow-progress-meter")).toBeVisible();
    expect((await progress.boundingBox())!.height).toBeLessThanOrEqual(100);
    const name = (await progress.locator(".workflow-run-name").boundingBox())!;
    await page.touchscreen.tap(name.x + name.width / 2, name.y + name.height / 2);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const sheet = (await dialog.boundingBox())!;
    expect(sheet.y).toBeGreaterThan(0);
    expect(Math.round(sheet.y + sheet.height)).toBe(844);

    // It opens on the step the run is waiting at, not on step 1.
    const scrollRegion = dialog.getByRole("region", { name: "Run steps" });
    await expect(scrollRegion.locator('.workflow-timeline-step[data-state="waiting"]')).toBeInViewport();
    // The summary stays pinned while the ledger scrolls under it.
    await scrollRegion.evaluate(region => { region.scrollTop = region.scrollHeight; });
    await expect(dialog.locator(".workflow-run-dialog-summary")).toBeInViewport();

    // Pulling the header down dismisses the sheet.
    const header = (await dialog.locator(".workflow-run-dialog-header").boundingBox())!;
    const x = header.x + header.width / 2;
    await page.mouse.move(x, header.y + 8);
    await page.mouse.down();
    await page.mouse.move(x, header.y + 60, { steps: 4 });
    await page.mouse.move(x, header.y + 160, { steps: 4 });
    await page.mouse.up();
    await expect(dialog).toBeHidden();
  });

  test("a task's run steps open from a full-height row", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, "en");
    await page.goto("/projects/release?task=ship&recordTab=activity");

    const details = page.locator(".record-workflow-history .record-workflow-details").first();
    const row = details.locator("summary");
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const chevron = details.locator(".record-workflow-chevron");
    await expect(chevron).toBeVisible();
    await row.tap();
    await expect(details).toHaveAttribute("open", "");
    await expect(chevron).toHaveCSS("rotate", "90deg");
  });
});
