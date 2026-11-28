import { expect, test } from "@playwright/test";

test("standalone workflows can be created, edited, toggled, and persist after reload without Teams", async ({ page }) => {
  const stamp = "2026-09-18T00:00:00Z";
  const computerId = "device:alice:host";
  const node = {
    id: "node-1", userId: "alice", workspaceId: "host", displayName: "Build Computer",
    online: true, stale: false, status: "ready", activeRuns: [], agents: { codex: "ready" },
  };
  const agents = ["lead", "builder"].map((id) => ({
    id, displayName: id === "lead" ? "Lead" : "Builder", executorKind: "codex",
    defaultRole: "implementer", supervisorUserId: "alice", enabled: true, availability: "ready",
    computerId, version: 1, createdAt: stamp, updatedAt: stamp,
    placements: [{ id: `place-${id}`, agentId: id, computerId, daemonNodeId: "node-1", nodeDisplayName: "Build Computer", desiredState: "active", status: "ready", priority: 0 }],
  }));

  type WorkflowRecord = {
    id: string;
    name: string;
    ownerUserId: string;
    projectId: null;
    computerId: string;
    enabled: boolean;
    version: number;
    kind?: "steps" | "predefined";
    predefined?: {
      template: "build_review" | "lead_led";
      memberAgentIds: string[];
      leadAgentId: string;
      humanApproval: boolean;
      acceptanceCriteria: string[];
    };
    workflowSteps: Array<{
      id: string;
      name: string;
      agentId: string;
      instructions: string;
      acceptanceCriteria: string[];
      requiresApproval: boolean;
    }>;
    createdAt: string;
    updatedAt: string;
  };

  const workflows: WorkflowRecord[] = [{
    id: "delivery",
    name: "Delivery",
    ownerUserId: "alice",
    projectId: null,
    computerId,
    enabled: true,
    version: 1,
    kind: "predefined",
    predefined: {
      template: "build_review",
      memberAgentIds: ["lead", "builder"],
      leadAgentId: "lead",
      humanApproval: true,
      acceptanceCriteria: ["Existing clients remain compatible"],
    },
    workflowSteps: [],
    createdAt: stamp,
    updatedAt: stamp,
  }];

  const createdPayloads: Record<string, unknown>[] = [];
  const patchPayloads: Record<string, unknown>[] = [];

  await page.route("**/api/**", async (route) => {
    const { pathname: path, searchParams } = new URL(route.request().url());
    const method = route.request().method();
    let body: unknown = { sessions: [], tasks: [], nodes: [node], projects: [], sandboxes: [], agents, teams: [] };

    if (path.endsWith("/auth/me")) {
      body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", language: "en", theme: "light" } };
    }
    if (path.endsWith("/workflows") && method === "GET" && searchParams.get("scope") === "standalone") {
      body = {
        view: "preview",
        workflows: workflows.map((wf) => ({
          id: wf.id, name: wf.name, projectId: null, computerId: wf.computerId,
          enabled: wf.enabled, version: wf.version, kind: wf.kind,
          createdAt: wf.createdAt, updatedAt: wf.updatedAt,
          workflowSteps: wf.workflowSteps.map(({ id, name, agentId, requiresApproval }) => ({ id, name, agentId, requiresApproval })),
        })),
      };
    }
    if (path.endsWith("/workflows") && method === "POST") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      createdPayloads.push(input);
      const created: WorkflowRecord = {
        id: "wf-ship",
        name: String(input.name),
        ownerUserId: "alice",
        projectId: null,
        computerId: String(input.computerId),
        enabled: true,
        version: 1,
        workflowSteps: input.workflowSteps as WorkflowRecord["workflowSteps"],
        createdAt: stamp,
        updatedAt: stamp,
      };
      workflows.push(created);
      body = { workflow: created };
    }
    const wfMatch = path.match(/\/workflows\/([^/]+)$/);
    if (wfMatch) {
      const target = workflows.find((wf) => wf.id === wfMatch[1]);
      if (method === "GET" && target) {
        body = { workflow: target };
      } else if (method === "PATCH" && target) {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        patchPayloads.push(patch);
        if (typeof patch.name === "string") target.name = patch.name;
        if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
        if (patch.workflowStepChanges && typeof patch.workflowStepChanges === "object") {
          const changes = patch.workflowStepChanges as { byId?: Record<string, Partial<WorkflowRecord["workflowSteps"][number]>> };
          for (const [stepId, fields] of Object.entries(changes.byId ?? {})) {
            const step = target.workflowSteps.find((s) => s.id === stepId);
            if (step) Object.assign(step, fields);
          }
        }
        target.version += 1;
        body = { workflow: target };
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  // Legacy /teams/<id> redirects to /workflows/<id> and renders migrated predefined workflow.
  await page.goto("/teams/delivery");
  await expect(page).toHaveURL(/\/workflows\/delivery$/);
  await expect(page.getByText("Build Computer").first()).toBeVisible();
  await expect(page.getByText("Execute and review", { exact: true })).toBeVisible();
  await expect(page.getByText("Existing clients remain compatible", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit steps", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete workflow", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rename workflow", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename workflow", exact: true });
  await rename.getByRole("textbox").fill("Renamed delivery");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect.poll(() => patchPayloads.at(-1)).toEqual({ name: "Renamed delivery", expectedVersion: 1 });
  await expect(page.getByRole("heading", { name: "Renamed delivery", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Renamed delivery", exact: true })).toBeVisible();

  // Create a new standalone Workflow without any Team or Project.
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New workflow" });
  await drawer.getByLabel("Workflow name", { exact: true }).fill("Release Flow");
  await drawer.getByLabel("Step name", { exact: true }).fill("Verify");
  await drawer.getByLabel("Instructions", { exact: true }).fill("Own the API and regression tests");
  await drawer.getByLabel(/^Acceptance criteria/).fill("Keep the build notes");
  await drawer.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect.poll(() => createdPayloads.at(-1)).toMatchObject({
    name: "Release Flow",
    projectId: null,
    computerId,
  });

  // Select the created workflow, edit its instructions, toggle disabled, and verify after reload.
  await page.getByRole("button", { name: /Release Flow/ }).click();
  await expect(page.getByText("Own the API and regression tests", { exact: true })).toBeVisible();
  await expect(page.getByText("Keep the build notes", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Edit steps", exact: true }).click();
  const editDrawer = page.getByRole("dialog", { name: "Edit workflow" });
  await editDrawer.getByRole("textbox", { name: "Instructions", exact: true }).fill("Run full API and UI regression suite");
  await editDrawer.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(page.getByText("Run full API and UI regression suite", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect.poll(() => patchPayloads.at(-1)).toEqual({ enabled: false });

  await page.reload();
  await expect(page.getByText("Run full API and UI regression suite", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
});
