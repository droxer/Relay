import { expect, test, type Page } from "@playwright/test";
import type { AgentRunInput } from "../src/types";

const stamp = "2026-11-28T00:00:00.000Z";
const computerId = "device:u1:host";
const node = { id: "node", userId: "u1", computerId, workspaceId: "host", name: "Work computer", activeRuns: [],
  online: true, stale: false, status: "ready", agents: { codex: "ready" }, capabilities: ["thread-workspaces", "project-workspaces", "image-attachments"] };
const agent = { id: "ada", displayName: "Ada", executorKind: "codex", defaultRole: "implementer", supervisorUserId: "u1",
  enabled: true, availability: "ready", version: 1, skills: [], computerId, createdAt: stamp, updatedAt: stamp,
  placements: [{ id: "placement", agentId: "ada", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }] };
const launch = { id: "launch", name: "Launch planning and the very long cross-team project name for narrow displays",
  ownerUserId: "u1", computerId, enabled: true, leadAgentId: "ada", version: 1, createdAt: stamp, updatedAt: stamp,
  workspaceLayout: "project", workspaceSubpath: "projects/launch", members: [{ agentId: "ada", role: "implementer", enabled: true }] };
const disabled = { ...launch, id: "disabled", name: "Disabled project", enabled: false };
const archived = { ...launch, id: "archived", name: "Archived project", archivedAt: stamp };

async function serve(page: Page, theme = "light", runStatus = () => 202) {
  const runs: AgentRunInput[] = [];
  const sessions: object[] = [];
  let thread: object;
  const projects = [launch, disabled, archived];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = { sessions, projects, agents: [agent], nodes: [node], tasks: [], teams: [], workflows: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "a1", userId: "u1", username: "Ada", role: "user", theme, language: "en" } };
    if (path.endsWith("/projects/launch")) body = { project: launch };
    if (path.endsWith("/threads/created-chat")) body = thread;
    if (path.endsWith("/queue")) body = { messages: [], paused: false };
    if (path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (path.endsWith("/thread-attachments") && method === "POST") {
      body = { id: "draft-image", mediaType: "image/png", bytes: 68, sha256: "digest" };
    }
    if (path.endsWith("/agent-runs") && method === "POST") {
      const input: AgentRunInput = route.request().postDataJSON();
      runs.push(input);
      const status = runStatus();
      if (status !== 202) return route.fulfill({ status, json: { detail: "Temporarily unavailable" } });
      thread = { id: "created-chat", projectId: input.projectId, taskGoal: input.taskGoal, ownerUserId: "u1",
        computerId, daemonNodeId: "node", status: "completed", phase: "done", participants: ["human"], participantAgentIds: ["ada"],
        events: [], agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], createdAt: stamp, updatedAt: stamp };
      sessions.push(thread);
      return route.fulfill({ status, json: thread });
    }
    await route.fulfill({ json: body });
  });
  return runs;
}

function chat(page: Page) {
  const composer = page.locator("form.composer");
  return {
    composer,
    project: composer.getByRole("combobox", { name: "Choose project", exact: true }),
    message: composer.getByRole("textbox"),
    send: composer.getByRole("button", { name: "Send", exact: true }),
  };
}

for (const width of [320, 768, 1440]) {
  test.describe(`${width}px project picker`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width === 320, isMobile: width === 320 });

    for (const theme of ["light", "dark"]) test(`fits and selects in ${theme}`, async ({ page }, testInfo) => {
      const runs = await serve(page, theme);
      await page.goto("/threads/new");
      const { project, message, send } = chat(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(project.getByText("No project", { exact: true })).toBeVisible();
      await expect(project).toBeEnabled();
      await message.fill("Draft for launch");
      if (width === 320) await project.tap();
      else await project.press("ArrowDown");
      const options = page.getByRole("listbox");
      const launchOption = options.getByRole("option", { name: launch.name, exact: true });
      await expect(launchOption).toBeVisible();
      await expect(options.getByRole("option")).toHaveCount(2);
      expect(await options.evaluate((el, width) => {
        const { left, right } = el.getBoundingClientRect();
        return left >= 0 && right <= width;
      }, width)).toBe(true);
      if (width === 320) await launchOption.tap();
      else {
        await expect(options.getByRole("option", { name: "No project", exact: true })).toBeFocused();
        await page.keyboard.press("End");
        await expect(launchOption).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(project).toBeFocused();
      }
      await expect(page).toHaveURL(/\/projects\/launch\/new$/);
      await expect(project.getByText(launch.name, { exact: true })).toBeVisible();
      await expect(message).toHaveValue("Draft for launch");
      await expect(send).toBeEnabled();
      expect(runs).toEqual([]);
      expect(await page.locator("html").evaluate(el => el.scrollWidth)).toBe(width);
      for (const control of [project, send]) {
        await expect(control).toBeInViewport();
      }
      expect(await project.getByText(launch.name).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      if ((width === 320 && theme === "dark") || (width === 1440 && theme === "light")) {
        await page.screenshot({ path: testInfo.outputPath("project-picker.png") });
      }
    });
  });
}

test("changes scope in place, keeps text and images, and sends a Project Chat", async ({ page }) => {
  const runs = await serve(page);
  let threadCreates = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/v1/threads") threadCreates++;
  });
  await page.goto("/threads");
  await page.locator("#thread-panel").getByRole("button", { name: "New chat", exact: true }).first().click();
  const { composer, project, message, send } = chat(page);
  await message.fill("Review the launch");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
  await composer.locator("input[type=file]").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: image });
  await expect(composer.getByRole("img", { name: "Attached image 1" })).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);
  await project.click();
  await page.getByRole("option", { name: launch.name, exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/launch\/new$/);
  await expect(message).toHaveValue("Review the launch");
  await expect(composer.getByRole("img", { name: "Attached image 1" })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(runs).toEqual([]);
  expect(threadCreates).toBe(0);

  await send.click();
  await expect(page).toHaveURL(/\/projects\/launch\/threads\/created-chat$/);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ projectId: "launch", taskGoal: "Review the launch", attachmentIds: ["draft-image"] });
  expect(runs[0].daemonNodeId).toBeUndefined();
  expect(runs[0].assignments).toBeUndefined();
  await expect(project).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/threads$/);
});

test("a new discussion preselects its Project and clearing returns to a standalone Chat", async ({ page }) => {
  const runs = await serve(page);
  await page.goto("/projects/launch?tab=discussions");
  await page.getByRole("button", { name: "New discussion", exact: true }).click();
  const { project, message, send } = chat(page);
  await expect(project.getByText(launch.name, { exact: true })).toBeVisible();
  await project.click();
  await page.getByRole("option", { name: "No project", exact: true }).click();
  await expect(page).toHaveURL(/\/threads\/new$/);
  await message.fill("Ask Ada directly");
  await send.click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0].projectId).toBeUndefined();
  expect(runs[0]).toMatchObject({ daemonNodeId: "node", assignments: [{ agentId: "ada" }] });
});

test("an unavailable Project keeps the unsent draft and blocks dispatch until cleared", async ({ page }) => {
  const runs = await serve(page);
  await page.goto("/threads/new");
  const { project, message, send } = chat(page);
  await message.fill("Keep this draft");
  await page.goto("/projects/disabled/new");
  await expect(project.getByText("Project unavailable", { exact: true })).toBeVisible();
  await expect(message).toHaveValue("Keep this draft");
  await expect(send).toBeDisabled();
  expect(runs).toEqual([]);
  await project.click();
  await page.getByRole("option", { name: "No project", exact: true }).click();
  await expect(message).toHaveValue("Keep this draft");
  await expect(send).toBeEnabled();
});

test("the Project stays locked during the first send and an unconfirmed retry", async ({ page }) => {
  let status = 503;
  const runs = await serve(page, "light", () => status);
  await page.goto("/projects/launch/new");
  const { project, message, send } = chat(page);
  await expect(project.getByText(launch.name, { exact: true })).toBeVisible();
  await message.fill("Retry in the same Project");
  await send.click();
  await expect(project).toBeDisabled();
  const retry = page.getByRole("button", { name: "Retry send", exact: true });
  await expect(retry).toBeEnabled();
  await expect(project).toBeDisabled();
  status = 202;
  await retry.click();
  await expect(page).toHaveURL(/\/projects\/launch\/threads\/created-chat$/);
  expect(runs).toHaveLength(4);
  for (const input of runs) expect(input).toMatchObject({ projectId: "launch", idempotencyKey: runs[0].idempotencyKey });
});
