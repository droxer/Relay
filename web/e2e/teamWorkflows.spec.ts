import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, failFirstSend = false, theme: "light" | "dark" = "light", projectCount = 1, legacy = false, projectSubset = false, withCustom = false, withTeam = true) {
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
    acceptancePolicy: "human", assignedTeamId: withTeam ? team.id : undefined, projectId: "project", ownerUserId: "alice",
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
  if (projectSubset) {
    project.members = project.members.filter(member => member.agentId === "lead");
    team = { ...team, defaultWorkflowId: "preset:pipeline", workflows: [{
      id: "wf_project", teamId: "delivery", projectId: "project", name: "Project delivery", enabled: true,
      workflowSteps: [{ id: "build", name: "Build", agentId: "lead", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }],
      createdAt: stamp, updatedAt: stamp,
    }] };
  }
  const projects = [project, { ...project, id: "web", name: "Web" }].slice(0, projectCount);
  if (legacy) team = { ...team, collaborationStyle: undefined, projectId: "project", workflowSteps: [
    { id: "build", name: "Build", agentId: "lead", instructions: "Build the change", acceptanceCriteria: ["Tests pass"], requiresApproval: false },
  ] };
  let workflows: Record<string, any>[] = legacy ? [{ id: team.id, name: team.name, projectId: "project", enabled: true, ownerUserId: "alice", workflowSteps: team.workflowSteps, createdAt: stamp, updatedAt: stamp }]
    : projectSubset ? team.workflows as Record<string, any>[] : [];
  if (withCustom && !workflows.length) workflows = [{ id: "wf_release", ownerUserId: "alice", projectId: "project", name: "Release", enabled: true,
    workflowSteps: [{ id: "build", name: "Build", agentId: "lead", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }], createdAt: stamp, updatedAt: stamp }];
  const linked = new Set((legacy || projectSubset ? workflows : []).map(workflow => workflow.id));
  const workflowWrites: Record<string, unknown>[] = [];
  const sends: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const teamView = { ...team, workflows: workflows.filter(workflow => linked.has(workflow.id)).map(workflow => ({ ...workflow, teamId: team.id })) };
    let body: unknown = { sessions: [session], agents, teams: withTeam ? [teamView] : [], tasks: [task], nodes: [node], projects, sandboxes: [], skills: [] };
    if (path.endsWith("/workflows")) {
      if (method === "POST") {
        const input = route.request().postDataJSON(); workflowWrites.push(input);
        const workflow = { ...input, ownerUserId: "alice", id: "wf_ship", createdAt: stamp, updatedAt: stamp };
        workflows.push(workflow); if (input.ownerTeamId) linked.add(workflow.id); body = { workflow };
      } else body = { workflows: workflows.filter(workflow => !new URL(route.request().url()).searchParams.get("projectId") || workflow.projectId === new URL(route.request().url()).searchParams.get("projectId")) };
    }
    const link = path.match(/\/teams\/delivery\/workflows\/([^/]+)\/link$/);
    if (link) { if (method === "PUT") linked.add(link[1]); else linked.delete(link[1]); body = { team: teamView }; }
    if (path.match(/\/workflows\/[^/]+\/runs$/)) { sends.push(route.request().postDataJSON()); body = { ...session, projectId: "project" }; }
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", theme, language: "en" } };
    if (path.endsWith("/teams/delivery") && method === "PATCH") {
      const patch = route.request().postDataJSON(); patches.push(patch); team = { ...team, ...patch }; body = { team };
    }
    if (path.endsWith("/tasks/task")) {
      if (method === "PATCH") { const patch = route.request().postDataJSON(); patches.push(patch); task = { ...task, ...patch, updatedAt: new Date(Date.parse(stamp) + patches.length * 1000).toISOString() }; }
      body = task;
    }
    if (path.endsWith("/projects/project")) body = { project };
    if (path.endsWith("/projects/web")) body = { project: projects[1] };
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
    if (path.endsWith("/runs") && method === "GET") body = { runs: [] };
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
    const library = page.getByRole("region", { name: /^Workflows/ });
    await library.locator('.workflow-team-row[data-kind="predefined"]').filter({ hasText: "Pipeline" })
      .getByRole("button", { name: "Set as default" }).click();
    await expect.poll(() => patches.at(-1)?.defaultWorkflowId).toBe("preset:pipeline");
    await page.reload();
    const saved = page.locator('.teams-detail .workflow-preview[data-style="pipeline"]');
    await expect(saved).toBeVisible();
    await saved.scrollIntoViewIfNeeded();
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-team-workflow-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
  });
}

test("a Project creates an independent workflow and a Team can assign it", async ({ page }) => {
  const { workflowWrites } = await fixture(page, false, "light", 2);
  await page.goto("/projects/web?tab=members");
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New workflow" });
  await expect(drawer.getByRole("combobox", { name: "Team", exact: true })).toHaveCount(0);
  await drawer.getByLabel("Workflow name", { exact: true }).fill("Ship it");
  await drawer.getByLabel("Step name", { exact: true }).fill("Build");
  await drawer.getByLabel("Instructions", { exact: true }).fill("Build the change");
  await drawer.getByLabel(/^Acceptance criteria/).fill("Tests pass");
  await drawer.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect.poll(() => workflowWrites.at(-1)?.projectId).toBe("web");
  expect(workflowWrites.at(-1)?.teamId).toBeUndefined();
  await page.goto("/teams/delivery");
  const library = page.getByRole("region", { name: /^Workflows/ });
  await library.getByRole("combobox", { name: "Assign workflow" }).click();
  await page.getByRole("option", { name: /^Ship it/ }).click();
  await expect(library.locator(".workflow-team-row")).toHaveCount(4);
  await expect(library).toContainText("Ship it");
});

test("a team with no eligible project explains how to make a custom workflow", async ({ page }) => {
  await fixture(page, false, "light", 0);
  await page.goto("/teams/delivery");
  const library = page.getByRole("region", { name: /^Workflows/ });
  await expect(library.locator(".workflow-team-row")).toHaveCount(3);
  await expect(library.getByRole("button", { name: "New workflow" })).toBeEnabled();
  await expect(library).toContainText("Create a workflow for this Team");
});

test("a Project Task selects and clears its Project Workflow", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, false, true, false);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await option(page, "Release").click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("wf_release");
  await expect.poll(() => patches.at(-1)?.assignedTeamId).toBeNull();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await page.getByRole("option", { name: "Use Project Agents", exact: true }).click();
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

for (const [device, width] of [["phone", 390], ["laptop", 1280]] as const) {
  test(`team workflow library keeps one layout grammar (${device})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, false, "light", 1, false, true);
    await page.goto("/teams/delivery");
    const library = page.getByRole("region", { name: /^Workflows/ });
    const assign = library.getByRole("combobox", { name: "Assign workflow" });
    const create = library.getByRole("button", { name: "New workflow", exact: true });
    await expect(create).toBeVisible();
    // Both head controls share one cluster on the trailing edge.
    const [assignBox, createBox, libraryBox] = await Promise.all([assign.boundingBox(), create.boundingBox(), library.boundingBox()]);
    expect(Math.abs(assignBox!.y - createBox!.y)).toBeLessThanOrEqual(1);
    expect(createBox!.x - (assignBox!.x + assignBox!.width)).toBeLessThanOrEqual(12);
    expect(libraryBox!.x + libraryBox!.width - (createBox!.x + createBox!.width)).toBeLessThanOrEqual(1);
    // The library opens a new section rather than abutting the default preview.
    const previewBottom = await page.locator(".teams-detail .workflow-preview").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(libraryBox!.y - previewBottom).toBeGreaterThanOrEqual(32);
    // Numbered steps carry the order, so no chevron can strand at a line start.
    await expect(library.locator(".workflow-flow .collab-style-arrow").first()).toBeHidden();
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
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

for (const mobile of [false, true]) {
  test(`legacy workflows are assigned in Teams and managed from Projects (${mobile ? "phone" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await fixture(page, false, "light", 1, true);
    await page.goto("/teams/delivery");
    const library = page.getByRole("region", { name: /^Workflows/ });
    await expect(library.locator(".workflow-team-row")).toHaveCount(4);
    await expect(page.locator(".workflow-preview-name")).toHaveText("Delivery");
    // The Project's name is the link to its Workflows tab.
    await expect(library.getByRole("link", { name: "API", exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/relay-workflow-library-${mobile ? "phone" : "desktop"}.png`, fullPage: true, animations: "disabled" });
    await library.getByRole("link", { name: "API", exact: true }).click();
    const projectWorkflows = page.getByRole("region", { name: /^Workflows/ });
    await expect(projectWorkflows.getByRole("button", { name: "Start run", exact: true })).toBeVisible();
    await expect(projectWorkflows.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await projectWorkflows.getByRole("button", { name: "Start run", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Start workflow" })).toBeVisible();
    expect(await page.locator("body").evaluate(el => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-workflow-project-${mobile ? "phone" : "desktop"}.png`, fullPage: true, animations: "disabled" });
  });
}

test("Project Tasks can choose a custom workflow from a larger Team", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, true);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save task", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await expect(page.getByRole("option", { name: /^Pipeline/ })).toHaveCount(0);
  await page.getByRole("option", { name: /^Project delivery/ }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("wf_project");
});

for (const mobile of [false, true]) {
  test(`Project Workflows run with no Teams (${mobile ? "phone" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { sends } = await fixture(page, false, "light", 1, false, false, true, false);
    await page.goto("/projects/project?tab=members");
    await expect(page.getByRole("tab", { name: "Collaboration", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: `/tmp/independent-workflows-${mobile ? "phone" : "desktop"}.png`, animations: "disabled", fullPage: true });
    const library = page.getByRole("region", { name: /^Workflows/ });
    await library.getByRole("button", { name: "Start run", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Start workflow" });
    await expect(dialog.getByRole("combobox", { name: "Team (optional)" })).toContainText("Independent");
    await dialog.getByRole("textbox", { name: /^Goal/ }).fill("Release the Project");
    await page.screenshot({ path: `/tmp/independent-workflow-run-${mobile ? "phone" : "desktop"}.png`, animations: "disabled", fullPage: true });
    await dialog.getByRole("button", { name: "Start run", exact: true }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].teamId).toBeUndefined();
    expect(await page.locator("body").evaluate(el => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}


test("a Project Task selects an independent workflow with no Teams", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, false, true, false);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await page.getByRole("option", { name: "Release", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Team (optional)", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("wf_release");
  expect(patches.at(-1)?.assignedTeamId).toBeNull();
  await expect(page.getByRole("button", { name: "Save task", exact: true })).toHaveCount(0);
  await expect(page.locator(".record-definition").getByText("Release", { exact: true })).toBeVisible();
});


for (const mobile of [false, true]) {
  test(`Team workflow creation needs no Project (${mobile ? "phone" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { workflowWrites } = await fixture(page, false, "light", 0);
    await page.goto("/teams/delivery");
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "New workflow" });
    await expect(drawer.getByRole("combobox", { name: "Project", exact: true })).toHaveCount(0);
    await drawer.getByLabel("Workflow name", { exact: true }).fill("Team delivery");
    await drawer.getByLabel("Step name", { exact: true }).fill("Build");
    await drawer.getByLabel("Instructions", { exact: true }).fill("Build the change");
    await drawer.getByLabel(/^Acceptance criteria/).fill("Tests pass");
    await drawer.getByRole("button", { name: "Save workflow", exact: true }).click();
    await expect.poll(() => workflowWrites.at(-1)?.ownerTeamId).toBe("delivery");
    expect(workflowWrites.at(-1)?.projectId).toBeNull();
    await expect(page.getByRole("region", { name: /^Workflows/ })).toContainText("Team-owned");
    await expect(drawer).toHaveCount(0);
    await page.locator(".workflow-team-row").filter({ hasText: "Team delivery" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/team-owned-workflow-${mobile ? "phone" : "desktop"}.png`, fullPage: true });
  });
}

test("the stacked Teams roster shows its rows on a tablet", async ({ page }) => {
  for (const width of [834, 1024, 1100]) {
    await page.setViewportSize({ width, height: 1112 });
    await fixture(page, false, "light", 1, false, true, true);
    await page.goto("/teams/delivery");
    await page.getByRole("region", { name: /^Workflows/ }).waitFor();
    // The detail below must not squeeze the roster into a scroller too short
    // for its own rows.
    const clipped = await page.locator(".teams-roster .teams-list").evaluate(list => {
      const scroller = list.parentElement!;
      return scroller.scrollHeight - scroller.clientHeight;
    });
    expect(clipped, `${width}px`).toBeLessThanOrEqual(1);
  }
});

test("a wrapped default workflow never starts a line with an arrow (phone)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, false, "light", 1, false, true);
  await page.goto("/teams/delivery");
  const sequence = page.locator(".teams-detail .workflow-preview .collab-style-sequence").first();
  await expect(sequence).toBeVisible();
  const stranded = await sequence.evaluate(list => {
    const left = list.getBoundingClientRect().left;
    return Array.from(list.querySelectorAll(".collab-style-arrow"))
      .filter(arrow => arrow.getBoundingClientRect().left - left < 24).length;
  });
  expect(stranded).toBe(0);
});
