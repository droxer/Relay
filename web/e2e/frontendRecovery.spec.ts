import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const now = new Date().toISOString();
  const session = {
    id: "review-thread", title: "Review thread", taskGoal: "Test frontend recovery",
    workspacePath: "/workspace", ownerEmployeeId: "review-user", participants: ["human"],
    status: "completed", phase: "created", createdAt: now, updatedAt: now,
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
    eventCount: 0, artifactCount: 0, runCount: 0,
  };
  const agent = {
    id: "review-agent", displayName: "Review Agent", executorKind: "claude",
    defaultRole: "implementer", instructions: "Test profile", enabled: true,
    availability: "ready", placements: [], skills: [], createdAt: now, updatedAt: now, version: 1,
  };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [session], agents: [agent], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/threads/review-thread")) body = session;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
});

test("rename prompt accepts a full replacement with the real input primitive", async ({ page }) => {
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Rename thread", exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.type("Complete new name");
  await expect(input).toHaveValue("Complete new name");
});

test("dirty agent profile survives cancelled sidebar and Back navigation", async ({ page }) => {
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Review Agent/ }).click();
  await page.getByRole("button", { name: /Edit profile/ }).click();
  const name = page.locator('input[name="agent-profile-name"]');
  await name.fill("Unsaved profile");
  await page.getByRole("link", { name: "Backlog", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: /Cancel/ }).click();
  await expect(name).toHaveValue("Unsaved profile");
  await expect(page).toHaveURL(/\/agents\/review-agent$/);
  await page.goBack();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: /Cancel/ }).click();
  await expect(name).toHaveValue("Unsaved profile");
  await expect(page).toHaveURL(/\/agents\/review-agent$/);
  await page.getByRole("link", { name: "Backlog", exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: /Discard/ }).click();
  await expect(page).toHaveURL(/\/backlog$/);
});

test("mobile Back asks once before discarding an agent draft", async ({ page }) => {
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Review Agent/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Edit profile/ }).click();
  await page.locator('input[name="agent-profile-name"]').fill("Mobile draft");
  await page.locator(".agents-mobile-back").click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: /Discard/ }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(confirmation).toHaveCount(0);
});
