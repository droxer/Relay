import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, failFirstSend = false, theme: "light" | "dark" = "light", projectCount = 1) {
  const stamp = "2026-09-25T00:00:00Z";
  const computerId = "device:alice:host";
  const agents = ["lead", "qa"].map((id) => ({
    id, displayName: id === "lead" ? "Builder" : "Reviewer", executorKind: "codex",
    defaultRole: id === "lead" ? "implementer" : "reviewer", supervisorUserId: "alice",
    enabled: true, availability: "ready", version: 1, skills: [],
    placements: [{ id: `placement-${id}`, agentId: id, computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp,
  }));
  let team: Record<string, unknown> = { id: "delivery", name: "Delivery", ownerUserId: "alice", leadAgentId: "lead", computerId,
    memberAgentIds: ["lead", "qa"], members: agents, lead: agents[0], enabled: true,
    collaborationStyle: "build_review", memberConfigs: {}, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp };
  let task = { id: "task", title: "Ship the fix", description: "Fix and review", status: "backlog", priority: "normal",
    acceptancePolicy: "human", assignedTeamId: team.id, projectId: "project", ownerUserId: "alice",
    isRoutine: false, linkedSessionIds: [], activity: [], events: [], createdAt: stamp, updatedAt: stamp };
  const session = { id: "style-thread", title: "Style thread", taskGoal: "Improve the API", teamId: team.id,
    ownerUserId: "alice", ownerAgentId: "lead", daemonNodeId: "node", computerId,
    workspacePath: "/workspace", status: "completed", phase: "created", participants: ["human"],
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
    eventCount: 0, artifactCount: 0, runCount: 0, createdAt: stamp, updatedAt: stamp };
  const node = { id: "node", userId: "alice", workspaceId: "host", computerId, name: "Computer",
    activeRuns: [],
    online: true, stale: false, status: "ready", agents: { codex: "ready" }, capabilities: ["thread-workspaces", "work-results"] };
  // The team's whole roster is enabled Project Agents, so project work may name it.
  const project = { id: "project", name: "API", ownerUserId: "alice", computerId, enabled: true, leadAgentId: "lead", version: 1,
    members: [{ agentId: "lead", role: "implementer", responsibilities: "", enabled: true }, { agentId: "qa", role: "reviewer", responsibilities: "", enabled: true }] };
  const projects = [project, { ...project, id: "web", name: "Web" }].slice(0, projectCount);
  const workflowWrites: Record<string, unknown>[] = [];
  const sends: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = { sessions: [session], agents, teams: [team], tasks: [task], nodes: [node], projects, sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", theme, language: "en" } };
    if (path.endsWith("/teams/delivery/workflows") && method === "POST") {
      const input = route.request().postDataJSON(); workflowWrites.push(input);
      const workflow = { ...input, id: "wf_ship", teamId: "delivery", createdAt: stamp, updatedAt: stamp };
      team = { ...team, workflows: [...((team.workflows as unknown[]) ?? []), workflow] };
      body = { workflow };
    }
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
    if (path.endsWith("/queue")) body = { messages: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { sends, patches, workflowWrites };
}

const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) });

for (const mobile of [false, true]) {
  test(`team default workflow saves with its role preview (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { patches } = await fixture(page);
    await page.goto("/teams/delivery");
    // Read and edit share one statement: name, kind, then who does what.
    const preview = page.locator(".teams-detail .workflow-preview");
    await expect(preview).toHaveAttribute("data-style", "build_review");
    await expect(preview.locator(".workflow-preview-kind")).toHaveText("Predefined");
    await expect(preview.locator(".collab-style-sequence li").filter({ hasText: "Builder: Builder" })).toBeVisible();
    await page.getByRole("button", { name: "Edit team" }).click();
    await page.getByRole("combobox", { name: "Default workflow", exact: true }).click();
    await expect(page.getByRole("option", { name: /^Solo/ })).toHaveCount(0);
    await option(page, "Pipeline").click();
    await expect(page.locator('.teams-detail .workflow-preview[data-style="pipeline"]')).toBeVisible();
    await page.getByRole("button", { name: "Save team", exact: true }).click();
    await expect.poll(() => patches.at(-1)?.defaultWorkflowId).toBe("preset:pipeline");
    await page.reload();
    const saved = page.locator('.teams-detail .workflow-preview[data-style="pipeline"]');
    await expect(saved).toBeVisible();
    await saved.scrollIntoViewIfNeeded();
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-team-workflow-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
  });
}

test("a team lists every workflow and creates its own in a chosen project", async ({ page }) => {
  const { workflowWrites } = await fixture(page, false, "light", 2);
  await page.goto("/teams/delivery");
  const library = page.getByRole("region", { name: /^Workflows/ });
  const rows = library.locator(".workflow-team-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Build and review");
  await expect(rows.first()).toContainText("Default");
  await library.getByRole("button", { name: "New workflow", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New workflow" });
  await drawer.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: "Web", exact: true }).click();
  await drawer.getByLabel("Workflow name", { exact: true }).fill("Ship it");
  await drawer.getByLabel("Step name", { exact: true }).fill("Build");
  await drawer.getByLabel("Instructions", { exact: true }).fill("Build the change");
  await drawer.getByLabel(/^Acceptance criteria/).fill("Tests pass");
  await drawer.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect.poll(() => workflowWrites.at(-1)?.projectId).toBe("web");
  expect(workflowWrites.at(-1)?.name).toBe("Ship it");
  await expect(rows).toHaveCount(4);
  await expect(rows.last()).toContainText("Ship it");
  await expect(rows.last()).toContainText("Custom");
  await expect(rows.last()).toContainText("1 step · Web");
  await expect(drawer).toHaveCount(0);
});

test("a team with no eligible project explains how to make a custom workflow", async ({ page }) => {
  await fixture(page, false, "light", 0);
  await page.goto("/teams/delivery");
  const library = page.getByRole("region", { name: /^Workflows/ });
  await expect(library.locator(".workflow-team-row")).toHaveCount(3);
  await expect(library.getByRole("button", { name: "New workflow" })).toHaveCount(0);
  await expect(library).toContainText("add this team’s agents to one of your Projects");
});

test("task workflow can be chosen and cleared to inherit the team default", async ({ page }) => {
  const { patches } = await fixture(page);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await expect(page.getByText("Team default · Build and review")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await option(page, "Pipeline").click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("preset:pipeline");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await page.getByRole("option", { name: "Team default · Build and review", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBeNull();
});

for (const theme of ["light", "dark"] as const) {
  test(`workflow preview fits a phone (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, false, theme);
    await page.goto("/teams/delivery");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Edit team" }).click();
    const preview = page.locator(".teams-detail .workflow-preview");
    await expect(preview).toBeVisible();
    const bounds = await preview.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-team-workflow-${theme}.png`, fullPage: true });
  });
}

test("composer sends a one-message workflow then returns to the team default", async ({ page }) => {
  const { sends } = await fixture(page);
  await page.goto("/threads/style-thread");
  const select = page.getByRole("combobox", { name: "Workflow" });
  await select.click();
  await expect(page.getByRole("option", { name: /^Solo/ })).toHaveCount(0);
  await option(page, "Lead-led").click();
  await page.locator('textarea[name="message"]').fill("Fix the API");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.at(-1)?.workflowId).toBe("preset:lead_led");
  expect(sends.at(-1)?.style).toBeUndefined();
  await expect(select).toContainText("Team default · Build and review");
});

test("failed sends retain the workflow and member mentions hide it", async ({ page }) => {
  const { sends } = await fixture(page, true);
  await page.goto("/threads/style-thread");
  const select = page.getByRole("combobox", { name: "Workflow" });
  await select.click();
  await option(page, "Pipeline").click();
  const text = page.locator('textarea[name="message"]');
  await text.fill("Fix the API");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(text).toHaveValue("Fix the API");
  await expect(select).toContainText("Pipeline");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  expect(sends.map((send) => send.workflowId)).toEqual(["preset:pipeline", "preset:pipeline"]);
  expect(sends[0].idempotencyKey).toBe(sends[1].idempotencyKey);
  await expect(select).toContainText("Team default · Build and review");
  await text.fill("@Builder fix the API");
  await expect(select).toHaveCount(0);
});
