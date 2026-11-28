import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  failFirstSend = false,
  theme: "light" | "dark" = "light",
  projectCount = 1,
  legacy = false,
  projectSubset = false,
  withCustom = false,
  withTeam = true,
  summarized = false,
) {
  const stamp = "2026-09-25T00:00:00Z";
  const computerId = "device:alice:host";
  const agents = ["lead", "qa"].map((id) => ({
    id, displayName: id === "lead" ? "Builder" : "Reviewer", executorKind: "codex",
    defaultRole: id === "lead" ? "implementer" : "reviewer", supervisorUserId: "alice",
    enabled: true, availability: "ready", version: 1, skills: [],
    placements: [{ id: `placement-${id}`, agentId: id, computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp,
  }));
  let team: Record<string, unknown> = {
    id: "delivery", name: "Delivery", ownerUserId: "alice", leadAgentId: "lead", computerId,
    memberAgentIds: ["lead", "qa"], members: agents, lead: agents[0], enabled: true,
    collaborationStyle: "build_review", memberConfigs: {}, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp,
    ...(summarized ? { version: 1 } : {}),
  };
  let task = {
    id: "task", title: "Ship the fix", description: "Fix and review", status: "backlog", priority: "normal",
    acceptancePolicy: "human", assignedTeamId: withTeam ? team.id : undefined, projectId: "project", ownerUserId: "alice",
    isRoutine: false, linkedSessionIds: [], activity: [], events: [], createdAt: stamp, updatedAt: stamp,
  };
  const standaloneTasks: Record<string, any>[] = [];
  const session = {
    id: "style-thread", title: "Style thread", taskGoal: "Improve the API", teamId: team.id,
    ownerUserId: "alice", ownerAgentId: "lead", daemonNodeId: "node", computerId,
    workspacePath: "/workspace", status: "completed", phase: "created", participants: ["human"],
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
    eventCount: 0, artifactCount: 0, runCount: 0, createdAt: stamp, updatedAt: stamp,
  };
  const node = {
    id: "node", userId: "alice", workspaceId: "host", computerId, displayName: "Computer", name: "Computer",
    activeRuns: [],
    online: true, stale: false, status: "ready", agents: { codex: "ready" }, capabilities: ["thread-workspaces", "work-results"],
  };
  const project = {
    id: "project", name: "API", ownerUserId: "alice", computerId, enabled: true, leadAgentId: "lead", version: 1,
    members: [
      { agentId: "lead", role: "implementer", responsibilities: "", enabled: true },
      { agentId: "qa", role: "reviewer", responsibilities: "", enabled: true },
    ],
  };
  if (projectSubset) {
    project.members = project.members.filter((member) => member.agentId === "lead");
    team = {
      ...team, defaultWorkflowId: "preset:pipeline", workflows: [{
        id: "wf_project", teamId: "delivery", projectId: "project", name: "Project delivery", enabled: true,
        workflowSteps: [{ id: "build", name: "Build", agentId: "lead", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }],
        createdAt: stamp, updatedAt: stamp,
      }],
    };
  }
  const projects = [project, { ...project, id: "web", name: "Web" }].slice(0, projectCount);
  if (legacy) {
    team = {
      ...team, collaborationStyle: undefined, projectId: "project", workflowSteps: [
        { id: "build", name: "Build", agentId: "lead", instructions: "Build the change", acceptanceCriteria: ["Tests pass"], requiresApproval: false },
      ],
    };
  }
  let workflows: Record<string, any>[] = legacy
    ? [{ id: team.id, name: team.name, projectId: "project", enabled: true, ownerUserId: "alice", workflowSteps: team.workflowSteps, createdAt: stamp, updatedAt: stamp }]
    : projectSubset ? team.workflows as Record<string, any>[] : [];
  if (withCustom && !workflows.length) {
    workflows = [{
      id: "wf_release", ownerUserId: "alice", projectId: "project", name: "Release", enabled: true,
      workflowSteps: [{ id: "build", name: "Build", agentId: "lead", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }],
      createdAt: stamp, updatedAt: stamp,
    }];
  }
  const standaloneWorkflows: Record<string, any>[] = [
    {
      id: "delivery",
      name: "Delivery",
      ownerUserId: "alice",
      projectId: null,
      computerId,
      kind: "predefined",
      predefined: {
        template: "build_review",
        memberAgentIds: ["lead", "qa"],
        leadAgentId: "lead",
        humanApproval: true,
        acceptanceCriteria: ["Tests pass"],
      },
      enabled: true,
      version: 1,
      workflowSteps: [],
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "wf_standalone",
      name: "Standalone release",
      ownerUserId: "alice",
      projectId: null,
      computerId,
      enabled: true,
      version: 1,
      workflowSteps: [{ id: "build", name: "Build", agentId: "lead", instructions: "Build standalone artifact", acceptanceCriteria: ["Artifact verified"], requiresApproval: true }],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  const linked = new Set((legacy || projectSubset ? workflows : []).map((workflow) => workflow.id));
  const workflowWrites: Record<string, unknown>[] = [];
  const sends: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const taskCreates: Record<string, unknown>[] = [];
  const preview = (workflow: Record<string, any>) => ({
    ...workflow,
    workflowSteps: workflow.workflowSteps.map(({ id, name, agentId, requiresApproval }: Record<string, any>) => ({ id, name, agentId, requiresApproval })),
  });
  await page.route("**/api/**", async (route) => {
    const { pathname: path, searchParams } = new URL(route.request().url());
    const method = route.request().method();
    const teamView = { ...team, workflows: workflows.filter((workflow) => linked.has(workflow.id)).map((workflow) => ({ ...workflow, teamId: team.id })) };
    let body: unknown = {
      sessions: [session], agents, teams: withTeam ? [teamView] : [],
      tasks: [task, ...standaloneTasks], nodes: [node], projects, sandboxes: [], skills: [],
    };
    if (summarized && path.endsWith("/teams") && method === "GET") {
      body = {
        view: "summary", teams: [{
          ...team, workflows: undefined, workflowOptions: workflows.filter((workflow) => linked.has(workflow.id)).map((workflow) => ({
            id: workflow.id, name: workflow.name, projectId: workflow.projectId, kind: "steps", enabled: true,
            stepAgentIds: ["lead"], stepCount: 1,
          })),
        }],
      };
    }
    if (path.endsWith("/teams/delivery") && method === "GET") {
      body = {
        team: summarized && searchParams.get("view") === "preview"
          ? { ...teamView, workflows: undefined, workflowPreviews: teamView.workflows.map(preview) }
          : teamView,
      };
    }
    if (path.endsWith("/workflows")) {
      if (method === "POST") {
        const input = route.request().postDataJSON();
        workflowWrites.push(input);
        const workflow = { ...input, ownerUserId: "alice", id: "wf_ship", version: 1, createdAt: stamp, updatedAt: stamp };
        if (input.computerId && !input.projectId) standaloneWorkflows.push(workflow);
        else workflows.push(workflow);
        if (input.ownerTeamId) linked.add(workflow.id);
        body = { workflow };
      } else if (searchParams.get("scope") === "standalone") {
        const view = searchParams.get("view");
        if (view === "choices") {
          body = {
            workflows: standaloneWorkflows.map((wf) => ({
              id: wf.id, name: wf.name, projectId: null, computerId: wf.computerId, enabled: wf.enabled,
              stepAgentIds: wf.kind === "predefined"
                ? wf.predefined.memberAgentIds
                : [...new Set(wf.workflowSteps.map((s: any) => s.agentId))],
            })),
          };
        } else if (view === "preview") {
          body = { view: "preview", workflows: standaloneWorkflows.map(preview) };
        } else {
          body = { workflows: standaloneWorkflows };
        }
      } else {
        const scope = searchParams.get("projectId");
        const records = workflows.filter((workflow) => !scope || workflow.projectId === scope);
        body = summarized && searchParams.get("view") === "preview"
          ? { view: "preview", workflows: records.map(preview) }
          : { workflows: records };
      }
    }
    const wfMatch = path.match(/\/workflows\/([^/]+)$/);
    if (wfMatch) {
      const wfId = wfMatch[1];
      const all = [...workflows, ...standaloneWorkflows];
      const found = all.find((w) => w.id === wfId);
      if (method === "GET" && found) {
        body = { workflow: searchParams.get("view") === "name" ? { id: found.id, name: found.name } : found };
      } else if (method === "PATCH" && found) {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        Object.assign(found, patch, { version: (found.version ?? 1) + 1 });
        body = { workflow: found };
      } else if (method === "DELETE" && found) {
        const idx = standaloneWorkflows.findIndex((w) => w.id === wfId);
        if (idx >= 0) standaloneWorkflows.splice(idx, 1);
        body = { deletedWorkflowId: wfId };
      }
    }
    if (path.match(/\/workflows\/[^/]+\/runs$/)) { sends.push(route.request().postDataJSON()); body = { ...session, projectId: "project" }; }
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", theme, language: "en" } };
    if (path.endsWith("/tasks") && method === "POST") {
      const input = route.request().postDataJSON();
      taskCreates.push(input);
      const created = {
        id: `standalone-${taskCreates.length}`,
        number: 100 + taskCreates.length,
        title: input.title,
        description: input.description ?? "",
        status: "backlog",
        priority: input.priority ?? "normal",
        acceptancePolicy: input.acceptancePolicy ?? "human",
        computerId: input.computerId,
        assignedWorkflowId: input.assignedWorkflowId,
        assignedAgentId: input.assignedAgentId,
        ownerUserId: "alice",
        isRoutine: false,
        linkedSessionIds: [],
        activity: [],
        events: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      standaloneTasks.push(created);
      body = created;
    }
    const taskMatch = path.match(/\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const target = taskMatch[1] === "task" ? task : standaloneTasks.find((t) => t.id === taskMatch[1]);
      if (target) {
        if (method === "PATCH") {
          const patch = route.request().postDataJSON();
          patches.push(patch);
          Object.assign(target, patch, { updatedAt: new Date(Date.parse(stamp) + patches.length * 1000).toISOString() });
        }
        body = target;
      }
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
  return { sends, patches, workflowWrites, taskCreates };
}

const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) });

test("standalone Workflows load previews and fetch full definition on selection", async ({ page }) => {
  await fixture(page, false, "light", 1, false, false, false, false, true);
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/workflows")) {
      reads.push(url.pathname + url.search);
    }
  });
  await page.goto("/workflows");
  const row = page.getByRole("button", { name: /Standalone release/ });
  await expect(row).toBeVisible();
  expect(reads).toEqual(["/api/v1/workflows?scope=standalone&view=preview"]);
  await row.click();
  await expect(page).toHaveURL(/\/workflows\/wf_standalone$/);
  await expect(page.getByText("Build standalone artifact", { exact: true })).toBeVisible();
  await expect(page.getByText("Artifact verified", { exact: true })).toBeVisible();
  expect(reads).toEqual(["/api/v1/workflows?scope=standalone&view=preview", "/api/v1/workflows/wf_standalone"]);
});

for (const mobile of [false, true]) {
  test(`standalone Workflow creation, disable, and delete need no Team or Project (${mobile ? "phone" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { workflowWrites } = await fixture(page, false, "light", 0, false, false, false, false, true);
    await page.goto("/workflows");
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "New workflow" });
    await expect(drawer.getByRole("combobox", { name: "Project", exact: true })).toHaveCount(0);
    await drawer.getByLabel("Workflow name", { exact: true }).fill("Nightly release");
    await drawer.getByLabel("Step name", { exact: true }).fill("Build");
    await drawer.getByLabel("Instructions", { exact: true }).fill("Build the change");
    await drawer.getByLabel(/^Acceptance criteria/).fill("Tests pass");
    await drawer.getByRole("button", { name: "Save workflow", exact: true }).click();
    await expect.poll(() => workflowWrites.at(-1)).toMatchObject({
      name: "Nightly release",
      projectId: null,
      computerId: "device:alice:host",
    });
    await expect(drawer).toHaveCount(0);
    await page.getByRole("button", { name: /Nightly release/ }).click();
    await expect(page.getByText("Build the change", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete workflow", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete workflow", exact: true }).click();
    await expect(page.getByRole("button", { name: /Nightly release/ })).toHaveCount(0);
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}

test("a standalone Task selects, saves, and clears a standalone Workflow without Teams", async ({ page }) => {
  const { taskCreates, patches } = await fixture(page, false, "light", 1, false, false, true, false, true);
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New task" });
  await drawer.getByRole("textbox", { name: /^Goal/ }).fill("Run standalone release");
  await drawer.getByRole("combobox", { name: "Assign to", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Teams/ })).toHaveCount(0);
  await page.getByRole("radio", { name: /^Workflows/ }).click();
  await expect(page.getByRole("option", { name: /^Release/ })).toHaveCount(0);
  await option(page, "Standalone release").click();
  await drawer.getByRole("button", { name: "Create task", exact: true }).click();
  await expect.poll(() => taskCreates.at(-1)).toMatchObject({
    title: "Run standalone release",
    computerId: "device:alice:host",
    assignedWorkflowId: "wf_standalone",
    assignedAgentId: null,
    assignedTeamId: null,
  });

  await page.goto("/tasks/standalone-1");
  await expect(page.locator(".record-definition").getByText("Standalone release", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Workflow", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Team", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBeNull();
});

for (const theme of ["light", "dark"] as const) {
  test(`migrated predefined standalone Workflow renders participants and fits phone (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture(page, false, theme, 1, false, false, false, false, true);
    await page.goto("/teams/delivery");
    await expect(page).toHaveURL(/\/workflows\/delivery$/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByText("Build and review", { exact: true })).toBeVisible();
    await expect(page.getByText("Builder", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit steps", exact: true })).toHaveCount(0);
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}

test("Project Workflows load previews until editing requests one definition", async ({ page }) => {
  await fixture(page, false, "light", 1, false, false, true, false, true);
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/workflows")) reads.push(url.pathname + url.search);
  });
  await page.goto("/projects/project?tab=members");
  const region = page.getByRole("region", { name: /^Workflows/ });
  await expect(region.getByRole("list", { name: "Steps of Release" })).toContainText("Build");
  const preview = "/api/v1/workflows?view=preview&projectId=project";
  expect(reads).toEqual([preview]);
  await region.getByRole("button", { name: "Start run", exact: true }).click();
  const starter = page.getByRole("dialog", { name: "Start workflow" });
  await expect(starter).toBeVisible();
  expect(reads).toEqual([preview]);
  await starter.getByRole("button", { name: "Cancel", exact: true }).click();
  await region.getByRole("button", { name: "Choose participants for Build and review", exact: true }).click();
  const participants = page.getByRole("dialog", { name: "Edit Workflow Agents" });
  await expect(participants.getByRole("checkbox", { name: /Builder/ })).toBeVisible();
  await expect(participants.getByRole("textbox", { name: "Instructions", exact: true })).toHaveCount(0);
  await participants.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(reads).toEqual([preview]);
  for (let opening = 0; opening < 2; opening++) {
    await region.getByRole("button", { name: "Edit steps", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit workflow" });
    await expect(editor.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Build it");
    expect(reads).toEqual([preview, "/api/v1/workflows/wf_release"]);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});

test("a Project creates an independent workflow with no Team required", async ({ page }) => {
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
});

test("a Project Task selects and clears its Project Workflow", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, false, true, false);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("radio", { name: "Workflow", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await option(page, "Release").click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("wf_release");
  await expect.poll(() => patches.at(-1)?.assignedTeamId).toBeNull();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBeNull();
});

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

test("transient send failures retry the same workflow and member mentions hide it", async ({ page }) => {
  const { sends } = await fixture(page, true);
  await page.goto("/threads/style-thread");
  const select = page.getByRole("combobox", { name: "Workflow" });
  await select.click();
  await expect(page.getByRole("option", { name: /^Pipeline/ })).toHaveCount(0);
  await option(page, "Lead-led").click();
  const text = page.locator('textarea[name="message"]');
  await text.fill("Fix the API");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  expect(sends.map((send) => send.workflowId)).toEqual(["preset:lead_led", "preset:lead_led"]);
  expect(sends[0].idempotencyKey).toBe(sends[1].idempotencyKey);
  await expect(select).toContainText("Team default · Build and review");
  await text.fill("@Builder fix the API");
  await expect(select).toHaveCount(0);
});

test("Project Tasks can choose a custom workflow from a larger Team", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, true);
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save task", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Assign to", exact: true }).click();
  await page.getByRole("option", { name: "Assign later", exact: true }).click();
  await page.getByRole("radio", { name: "Workflow", exact: true }).click();
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
    const library = page.getByRole("region", { name: /^Workflows/ });
    await library.getByRole("button", { name: "Start run", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Start workflow" });
    await expect(dialog.getByRole("combobox", { name: "Team (optional)" })).toContainText("Independent");
    await dialog.getByRole("textbox", { name: /^Goal/ }).fill("Release the Project");
    await dialog.getByRole("button", { name: "Start run", exact: true }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].teamId).toBeUndefined();
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });

  test(`Project presets start from the Project roster (${mobile ? "phone" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { sends } = await fixture(page, false, "light", 1, false, false, false, false);
    await page.goto("/projects/project?tab=members");
    const library = page.getByRole("region", { name: /^Workflows/ });
    await expect(library.getByRole("button", { name: /^Start run for / })).toHaveCount(2);
    await library.getByRole("button", { name: "Start run for Build and review", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Start workflow" });
    await expect(dialog.getByRole("combobox", { name: "Team (optional)" })).toHaveCount(0);
    await dialog.getByRole("textbox", { name: /^Goal/ }).fill("Release with review");
    const submitted = page.waitForRequest((request) =>
      request.method() === "POST" && decodeURIComponent(new URL(request.url()).pathname).endsWith("/workflows/preset:build_review/runs"));
    await dialog.getByRole("button", { name: "Start run", exact: true }).click();
    await submitted;
    await expect.poll(() => sends[0]).toEqual({ requestId: expect.any(String), projectId: "project", taskGoal: "Release with review" });
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}

test("a Project Task selects an independent workflow with no Teams", async ({ page }) => {
  const { patches } = await fixture(page, false, "light", 1, false, false, true, false);
  const workflowReads: string[] = [];
  page.on("request", (request) => {
    const { pathname, search } = new URL(request.url());
    if (request.method() === "GET" && pathname.startsWith("/api/v1/workflows")) workflowReads.push(pathname + search);
  });
  await page.goto("/projects/project?task=task&recordTab=definition");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("radio", { name: "Workflow", exact: true }).click();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).click();
  await option(page, "Release").click();
  await expect(page.getByRole("combobox", { name: "Team (optional)", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect.poll(() => patches.at(-1)?.assignedWorkflowId).toBe("wf_release");
  expect(patches.at(-1)?.assignedTeamId).toBeNull();
  await expect(page.getByRole("button", { name: "Save task", exact: true })).toHaveCount(0);
  await expect(page.locator(".record-definition").getByText("Release", { exact: true })).toBeVisible();
  expect(workflowReads).toEqual(["/api/v1/workflows?view=choices&projectId=project"]);
});

test("the stacked Workflows roster shows its rows on a tablet", async ({ page }) => {
  for (const width of [834, 1024, 1100]) {
    await page.setViewportSize({ width, height: 1112 });
    await fixture(page, false, "light", 1, false, false, false, false, true);
    await page.goto("/workflows/wf_standalone");
    await expect(page.getByText("Build standalone artifact", { exact: true })).toBeVisible();
    const clipped = await page.locator(".teams-roster .teams-list").evaluate((list) => {
      const scroller = list.parentElement!;
      return scroller.scrollHeight - scroller.clientHeight;
    });
    expect(clipped, `${width}px`).toBeLessThanOrEqual(1);
  }
});

for (const [language, leadLabel, participantsLabel] of [
  ["en", "Lead", "Participating Agents"],
  ["zh-CN", "负责人", "参加的智能体"],
  ["zh-TW", "負責人", "參與的代理"],
] as const) {
  test(`migrated standalone Workflow translates its Lead label (${language})`, async ({ page }) => {
    await fixture(page);
    await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: {
      authenticated: true,
      user: { id: "alice", userId: "alice", username: "alice", role: "user", theme: "light", language },
    } }));
    const workflow = {
      id: "wf_migrated", name: "Delivery 流程", kind: "predefined", projectId: null,
      computerId: "device:alice:host", ownerUserId: "alice", enabled: true, version: 1,
      workflowSteps: [], createdAt: "2026-11-28T00:00:00Z", updatedAt: "2026-11-28T00:00:00Z",
      predefined: {
        template: "lead_led", memberAgentIds: ["lead", "qa"], leadAgentId: "lead",
        humanApproval: false, acceptanceCriteria: [],
      },
    };
    await page.route("**/api/v1/workflows**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith("/wf_migrated")
        ? { workflow } : { view: "preview", workflows: [workflow] } });
    });

    await page.goto("/workflows/wf_migrated");
    const participants = page.getByRole("list", { name: participantsLabel, exact: true });
    await expect(participants.getByText("Builder", { exact: true })).toBeVisible();
    await expect(participants.getByText("Reviewer", { exact: true })).toBeVisible();
    await expect(participants.getByText(leadLabel, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Delivery 流程", exact: true })).toBeVisible();
    await expect(page.getByText("collab.turn_lead", { exact: true })).toHaveCount(0);
  });
}
