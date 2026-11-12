import { expect, test, type Page } from "@playwright/test";

const stamp = "2026-11-12T00:00:00Z";
const agent = { id: "agt_reviewer", displayName: "Reviewer", executorKind: "claude", defaultRole: "reviewer", supervisorUserId: "u", enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null, createdAt: stamp, updatedAt: stamp,
  placements: [{ id: "p1", agentId: "agt_reviewer", computerId: "device:u:host", daemonNodeId: "node", desiredState: "active", status: "ready" }] };
const node = { id: "node", userId: "u", computerId: "device:u:host", workspaceId: "host", name: "Laptop", activeRuns: [], online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces"] };
const thread = { id: "queue-thread", taskGoal: "Review the release", workspacePath: "/workspace", computerId: node.computerId, daemonNodeId: node.id, ownerUserId: "u", ownerAgentId: agent.id, participants: ["human"], participantAgentIds: [agent.id], status: "running", phase: "claude", createdAt: stamp, updatedAt: stamp,
  execution: { phase: "running", confirmed: true }, agentRuns: [{ id: "r1", agent: "claude", logicalAgentId: agent.id, status: "running", startedAt: stamp, artifactIds: [] }], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0 };

for (const theme of ["light", "dark"] as const) {
  test(`queue synchronizes laptop and phone, with recoverable errors (${theme})`, async ({ browser }, info) => {
    const laptop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    let queue = { messages: [] as { id: string; text: string }[], paused: false };
    let fail = false;
    async function serve(page: Page) {
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        let body: unknown = { sessions: [thread], agents: [agent], nodes: [node], teams: [], tasks: [], projects: [], skills: [], sandboxes: [], files: [], entries: [] };
        if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme, language: "en" } };
        if (path.endsWith(`/threads/${thread.id}`)) body = thread;
        if (path.endsWith("/events")) { await route.fulfill({ contentType: "text/event-stream", body: "" }); return; }
        if (path.endsWith("/cancellations")) {
          if (!route.request().postDataJSON().preserveQueue) queue.paused = true;
          body = thread;
        }
        if (path.endsWith("/queue")) {
          if (route.request().method() === "POST") {
            if (fail) { await route.fulfill({ status: 503, json: { detail: "Connection unavailable. Try again." } }); return; }
            const { action, id, text } = route.request().postDataJSON();
            if (action === "enqueue") queue.messages.push({ id, text });
            if (action === "remove" || action === "edit") queue.messages = queue.messages.filter(m => m.id !== id);
            if (action === "pause") queue.paused = true;
            if (action === "resume") queue.paused = false;
          }
          body = queue;
        }
        await route.fulfill({ json: body });
      });
      await page.goto(`/threads/${thread.id}`);
    }
    const a = await laptop.newPage(); const b = await phone.newPage();
    await serve(a);
    const editor = a.locator("textarea").first();
    await editor.fill("Then check the release notes on mobile");
    await a.getByRole("button", { name: "Enter to queue for the next turn", exact: true }).click();
    await expect(a.locator(".message-queue")).toContainText("Saved across devices");
    await serve(b);
    await expect(b.locator(".message-queue")).toContainText("Then check the release notes on mobile");
    await b.getByRole("button", { name: "Edit queued message 1", exact: true }).click();
    await expect(b.locator("textarea").first()).toHaveValue("Then check the release notes on mobile");
    await expect(a.locator(".message-queue")).toHaveCount(0);
    fail = true;
    await b.getByRole("button", { name: "Enter to queue for the next turn", exact: true }).click();
    await expect(b.locator(".message-queue").getByRole("alert")).toContainText("Connection unavailable");
    await expect(b.locator("textarea").first()).toHaveValue("Then check the release notes on mobile");
    fail = false;
    await b.getByRole("button", { name: "Enter to queue for the next turn", exact: true }).click();
    await expect(b.locator(".message-queue")).toContainText("Saved across devices");
    await b.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(b.locator(".message-queue")).toContainText("Queue paused");
    await expect(a.locator(".message-queue")).toContainText("Queue paused");
    await b.getByRole("button", { name: "Resume queue", exact: true }).click();
    await expect(b.locator(".message-queue")).toContainText("Saved across devices");
    for (const [name, page] of [["desktop", a], ["phone", b]] as const) {
      await expect(page.locator(".message-queue")).toBeVisible();
      const box = await page.locator(".message-queue").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.screenshot({ path: info.outputPath(`queue-${theme}-${name}.png`) });
    }
    await laptop.close(); await phone.close();
  });
}
