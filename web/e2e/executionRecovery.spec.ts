import { test, expect, type Page } from "@playwright/test";

const now = new Date().toISOString();
const executionFor = (reason: string) => ({ phase: "recovery_required", blockingReason: reason, canDelete: false, executionConfirmed: false, deletionRequested: false, lastConfirmedAt: null, nextRecoveryAt: null });
const sessionFor = (reason: string) => ({ id: "recovery-thread", title: "Recovery thread", taskGoal: "Recover execution", workspacePath: "/workspace", computerId: "computer-1", ownerEmployeeId: "review-user", participants: ["human"], status: "failed", phase: "created", createdAt: now, updatedAt: now, agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0, artifactCount: 0, runCount: 0, execution: executionFor(reason) });

async function serveRecoveryThread(page: Page, reason: string, phase = "recovery_required"): Promise<string[]> {
  const session = sessionFor(reason);
  session.execution.phase = phase;
  const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [session], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/threads/recovery-thread")) body = session;
    if (route.request().method() === "POST") {
      writes.push(path);
      body = session.execution;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return writes;
}

/* A finger, not a mouse: the panel's way out has to be as big as every other
   control a11y.css grows on a coarse pointer — height AND width, which a bare
   text anchor never had. */
test("recovery actions stay full-size controls under a finger", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await serveRecoveryThread(page, "termination_unconfirmed");
  await page.goto("/threads/recovery-thread");
  const link = page.getByRole("region", { name: "Next steps" }).getByRole("link", { name: "Open Computers" });
  await expect(link).toBeVisible();
  const [box, target] = await Promise.all([
    link.boundingBox(),
    page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--touch-target"))),
  ]);
  expect(target).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThanOrEqual(target);
  expect(box!.width).toBeGreaterThanOrEqual(target);
  await context.close();
});

for (const reason of ["finalization_failed", "termination_unconfirmed"]) {
  test(`thread recovery offers the safe action for ${reason}`, async ({ page }, testInfo) => {
    const now = new Date().toISOString();
    const execution = { phase: "recovery_required", blockingReason: reason, canDelete: false, executionConfirmed: false, deletionRequested: false, lastConfirmedAt: null, nextRecoveryAt: null };
    const session = { id: "recovery-thread", title: "Recovery thread", taskGoal: "Recover execution", workspacePath: "/workspace", computerId: "computer-1", ownerEmployeeId: "review-user", participants: ["human"], status: "failed", phase: "created", createdAt: now, updatedAt: now, agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0, artifactCount: 0, runCount: 0, execution };
    const writes: string[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [session], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" } };
      if (path.endsWith("/threads/recovery-thread")) body = session;
      if (route.request().method() === "POST") {
        writes.push(path);
        body = execution;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/threads/recovery-thread");
    const panel = page.getByRole("region", { name: "Next steps" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Computer: computer-1");
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("recovery-mobile.png") });
    if (reason === "finalization_failed") {
      await panel.getByRole("button", { name: "Retry saving results" }).click();
      await expect(panel).toContainText("Recovery requested");
      expect(writes).toEqual(["/api/v1/threads/recovery-thread/execution/recovery"]);
    } else {
      await expect(panel.getByRole("button", { name: "Retry saving results" })).toHaveCount(0);
      await panel.getByRole("link", { name: "Open Computers" }).click();
      await expect(page).toHaveURL(/\/settings\/computers$/);
      expect(writes).toEqual([]);
    }
  });
}

/* The dead end this closes: a computer that never reports exit holds the
   execution forever, so the thread cannot be deleted and the node cannot be
   deleted either. The assertion is destructive, so it must pass a confirm. */
test("reporting an agent gone asks first, then calls reconcile", async ({ page }) => {
  const writes = await serveRecoveryThread(page, "orphaned_run");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/threads/recovery-thread");
  const panel = page.getByRole("region", { name: "Next steps" });
  await panel.getByRole("button", { name: "Report the agent as gone" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("cannot be undone");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(writes).toEqual([]);

  await panel.getByRole("button", { name: "Report the agent as gone" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Report the agent as gone" }).click();
  await expect(panel).toContainText("The execution is released");
  expect(writes).toEqual(["/api/v1/threads/recovery-thread/execution/reconcile"]);
});


for (const phase of ["queued", "unresponsive", "stopping", "finalizing"]) {
  test(`unknown ${phase} execution never offers an invalid recovery action`, async ({ page }) => {
    const writes = await serveRecoveryThread(page, "future_reason", phase);
    await page.goto("/threads/recovery-thread");
    const panel = page.getByRole("region", { name: "Next steps" });
    await expect(panel).toContainText("The cause of this blocker is unknown");
    await expect(panel.getByRole("button")).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
