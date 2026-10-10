import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, failFirstSend = false, theme: "light" | "dark" = "light") {
  const stamp = "2026-09-25T00:00:00Z";
  const computerId = "device:alice:host";
  const agents = ["lead", "qa"].map((id) => ({
    id, displayName: id === "lead" ? "Builder" : "Reviewer", executorKind: "codex",
    defaultRole: id === "lead" ? "implementer" : "reviewer", supervisorEmployeeId: "alice",
    enabled: true, availability: "ready", version: 1, skills: [],
    placements: [{ id: `placement-${id}`, agentId: id, computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp,
  }));
  let team = { id: "delivery", name: "Delivery", ownerEmployeeId: "alice", leadAgentId: "lead",
    memberAgentIds: ["lead", "qa"], members: agents, lead: agents[0], enabled: true,
    collaborationStyle: "build_review", memberConfigs: {}, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp };
  let task = { id: "task", title: "Ship the fix", description: "Fix and review", status: "backlog", priority: "normal",
    acceptancePolicy: "human", assignedTeamId: team.id, projectId: "project", ownerEmployeeId: "alice",
    isRoutine: false, routineEnabled: false, linkedSessionIds: [], activity: [], events: [], createdAt: stamp, updatedAt: stamp };
  const session = { id: "style-thread", title: "Style thread", taskGoal: "Improve the API", teamId: team.id,
    ownerEmployeeId: "alice", ownerAgentId: "lead", daemonNodeId: "node", computerId,
    workspacePath: "/workspace", status: "completed", phase: "created", participants: ["human"],
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
    eventCount: 0, artifactCount: 0, runCount: 0, createdAt: stamp, updatedAt: stamp };
  const node = { id: "node", employeeId: "alice", workspaceId: "host", computerId, name: "Computer",
    activeRuns: [],
    online: true, stale: false, status: "ready", agents: { codex: "ready" }, capabilities: ["thread-workspaces", "work-results"] };
  const project = { id: "project", name: "API", ownerEmployeeId: "alice", computerId, enabled: true, members: [], version: 1 };
  const sends: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = { sessions: [session], agents, teams: [team], tasks: [task], nodes: [node], projects: [project], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", employeeId: "alice", username: "alice", role: "employee", theme, language: "en" } };
    if (path.endsWith("/teams/delivery") && method === "PATCH") {
      const patch = route.request().postDataJSON(); patches.push(patch); team = { ...team, ...patch }; body = { team };
    }
    if (path.endsWith("/tasks/task")) {
      if (method === "PATCH") { const patch = route.request().postDataJSON(); patches.push(patch); task = { ...task, ...patch }; }
      body = task;
    }
    if (path.endsWith("/threads/style-thread")) body = session;
    if (path.endsWith("/messages") || path.endsWith("/agent-runs")) {
      sends.push(route.request().postDataJSON());
      if (failFirstSend) {
        failFirstSend = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Temporarily unavailable" }) });
        return;
      }
      body = session;
    }
    if (path.endsWith("/events")) body = { events: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { sends, patches };
}

for (const mobile of [false, true]) {
  test(`team style saves with preview (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { patches } = await fixture(page);
    await page.goto("/teams/delivery");
    await expect(page.locator(".collab-style-sequence li").filter({ hasText: "Builder: Builder" })).toBeVisible();
    await page.getByRole("button", { name: "Edit members" }).click();
    const styles = page.getByRole("radiogroup", { name: "How this team works" });
    await expect(styles.getByRole("radio")).toHaveCount(3);
    await expect(styles.getByRole("radio", { name: "Solo", exact: true })).toHaveCount(0);
    await styles.getByRole("radio", { name: "Pipeline", exact: true }).click();
    await expect(styles.getByRole("radio", { name: "Pipeline", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Save team", exact: true }).click();
    await expect.poll(() => patches.at(-1)?.collaborationStyle).toBe("pipeline");
    await page.reload();
    const badge = page.locator('.teams-detail .collab-style-summary[data-style="pipeline"]');
    await expect(badge).toBeVisible();
    await badge.scrollIntoViewIfNeeded();
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-style-team-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
  });
}

test("task override can be saved and cleared to inherit", async ({ page }) => {
  const { patches } = await fixture(page);
  await page.goto("/backlog/task?tab=definition");
  await expect(page.getByText("Team default (Build → Review)")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Collaboration", exact: true }).click();
  await expect(page.getByRole("option", { name: "Solo", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Pipeline", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.collaborationStyle).toBe("pipeline");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Collaboration", exact: true }).click();
  await page.getByRole("option", { name: "Team default (Build → Review)", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.collaborationStyle).toBe("");
});

for (const theme of ["light", "dark"] as const) {
  test(`style picker visual and keyboard check (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, false, theme);
    await page.goto("/teams/delivery");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Edit members" }).click();
    const styles = page.getByRole("radiogroup", { name: "How this team works" });
    const current = styles.getByRole("radio", { name: "Build → Review", exact: true });
    await current.focus();
    await expect(current).toBeChecked();
    // Arrow keys rove and select within the group, like any radio group.
    await page.keyboard.press("ArrowDown");
    const pipeline = styles.getByRole("radio", { name: "Pipeline", exact: true });
    await expect(pipeline).toBeFocused();
    await expect(pipeline).toBeChecked();
    await expect(page.getByText("Every member takes a turn in role order.")).toBeVisible();
    for (const card of await styles.getByRole("radio").all()) {
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    }
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-style-picker-${theme}.png`, fullPage: true });
  });
}

test("composer sends a one-message override then returns to team default", async ({ page }) => {
  const { sends } = await fixture(page);
  await page.goto("/threads/style-thread");
  const select = page.getByRole("combobox", { name: "Style for this message" });
  await select.click();
  await expect(page.getByRole("option", { name: "Solo", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Lead-led", exact: true }).click();
  await page.locator('textarea[name="message"]').fill("Fix the API");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/relay-style-composer.png", fullPage: true });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.at(-1)?.style).toBe("lead_led");
  await expect(select).toContainText("Build → Review · team default");
});

test("failed sends retain the override and member mentions hide it", async ({ page }) => {
  const { sends } = await fixture(page, true);
  await page.goto("/threads/style-thread");
  const select = page.getByRole("combobox", { name: "Style for this message" });
  await select.click();
  await page.getByRole("option", { name: "Pipeline", exact: true }).click();
  const text = page.locator('textarea[name="message"]');
  await text.fill("Fix the API");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(text).toHaveValue("Fix the API");
  await expect(select).toContainText("Pipeline");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  expect(sends.map((send) => send.style)).toEqual(["pipeline", "pipeline"]);
  expect(sends[0].idempotencyKey).toBe(sends[1].idempotencyKey);
  await expect(select).toContainText("Build → Review · team default");
  await text.fill("@Builder fix the API");
  await expect(select).toHaveCount(0);
});
