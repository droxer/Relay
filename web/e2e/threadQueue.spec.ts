import { expect, test, type Page } from "@playwright/test";

import en from "../src/i18n/locales/en/translation.json" with { type: "json" };
import zhCN from "../src/i18n/locales/zh-CN/translation.json" with { type: "json" };
import zhTW from "../src/i18n/locales/zh-TW/translation.json" with { type: "json" };

const stamp = "2026-11-12T00:00:00Z";
const agent = { id: "agt_reviewer", displayName: "Reviewer", executorKind: "claude", defaultRole: "reviewer", supervisorUserId: "u", enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null, createdAt: stamp, updatedAt: stamp,
  placements: [{ id: "p1", agentId: "agt_reviewer", computerId: "device:u:host", daemonNodeId: "node", desiredState: "active", status: "ready" }] };
const node = { id: "node", userId: "u", computerId: "device:u:host", workspaceId: "host", name: "Laptop", activeRuns: [], online: true, stale: false, status: "ready", agents: { claude: "ready" }, capabilities: ["thread-workspaces"] };
const thread = { id: "queue-thread", taskGoal: "Review the release", workspacePath: "/workspace", computerId: node.computerId, daemonNodeId: node.id, ownerUserId: "u", ownerAgentId: agent.id, participants: ["human"], participantAgentIds: [agent.id], status: "running", phase: "claude", createdAt: stamp, updatedAt: stamp,
  execution: { phase: "running", confirmed: true }, agentRuns: [{ id: "r1", agent: "claude", logicalAgentId: agent.id, status: "running", startedAt: stamp, artifactIds: [] }], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0 };

for (const theme of ["light", "dark"] as const) for (const language of ["en", "zh-CN", "zh-TW"] as const) {
  const copy = (language === "en" ? en : language === "zh-CN" ? zhCN : zhTW).queue;
  const label = (value: string) => value.replace("{{number}}", "1");
  test(`queue synchronizes laptop and phone, with recoverable errors (${theme}, ${language})`, async ({ browser }, info) => {
    const laptop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    let queue: { messages: { id: string; text: string; addressAgentIds?: string[] }[]; paused: boolean; removed?: { message: { id: string; text: string; addressAgentIds?: string[] }; beforeId: string | null } } = { messages: [], paused: false };
    let fail = false;
    async function serve(page: Page) {
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        let body: unknown = { sessions: [thread], agents: [agent], nodes: [node], teams: [], tasks: [], projects: [], skills: [], sandboxes: [], files: [], entries: [] };
        if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme, language } };
        if (path.endsWith(`/threads/${thread.id}`)) body = thread;
        if (path.endsWith("/events")) { await route.fulfill({ contentType: "text/event-stream", body: "" }); return; }
        if (path.endsWith("/cancellations")) {
          if (!route.request().postDataJSON().preserveQueue) queue.paused = true;
          body = thread;
        }
        if (path.endsWith("/queue")) {
          if (route.request().method() === "POST") {
            if (fail) { await route.fulfill({ status: 503, json: { detail: "Connection unavailable. Try again." } }); return; }
            const { action, id, text, addressAgentIds } = route.request().postDataJSON();
            if (action === "enqueue") {
              expect(addressAgentIds).toEqual([agent.id]);
              queue.messages.push({ id, text, addressAgentIds });
            }
            if (action === "remove") {
              const index = queue.messages.findIndex(m => m.id === id);
              if (index >= 0) queue.removed = { message: queue.messages[index], beforeId: queue.messages[index + 1]?.id ?? null };
            }
            if (action === "undo_remove" && queue.removed) {
              const before = queue.messages.findIndex(m => m.id === queue.removed!.beforeId);
              queue.messages.splice(before < 0 ? queue.messages.length : before, 0, queue.removed.message);
              delete queue.removed;
            }
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
    await a.locator(".composer-queue-button").click();
    await expect(a.locator(".message-queue")).toContainText(copy.saved.replace("{{count}}", "1"));
    await serve(b);
    await expect(b.locator(".message-queue")).toContainText("Then check the release notes on mobile");
    await expect(b.locator(".message-queue-recipient")).toContainText("Reviewer");
    await expect(b.getByRole("button", { name: label(copy.steer_item), exact: true })).toBeVisible();
    await b.getByRole("button", { name: label(copy.remove_item), exact: true }).click();
    await b.screenshot({ path: info.outputPath("queue-undo-phone.png") });
    await b.getByRole("button", { name: copy.undo, exact: true }).click();
    const preview = b.getByRole("button", { name: `${label(copy.preview_item)}: Then check the release notes on mobile` });
    await preview.click();
    await expect(b.locator(".message-queue-preview")).toContainText("Then check the release notes on mobile");
    await expect(b.locator("textarea").first()).toHaveValue("");
    const editBox = await b.locator(".message-queue-preview button").boundingBox();
    const listBox = await b.locator(".message-queue-list").boundingBox();
    expect(editBox!.y + editBox!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1);
    await b.screenshot({ path: info.outputPath("queue-expanded-phone.png") });
    await b.getByRole("button", { name: label(copy.edit_item), exact: true }).click();
    await expect(b.locator("textarea").first()).toHaveValue("Then check the release notes on mobile");
    await expect(a.locator(".message-queue")).toHaveCount(0);
    fail = true;
    await b.locator(".composer-queue-button").click();
    await expect(b.locator(".message-queue").getByRole("alert")).toContainText(copy.errors.change_failed);
    await expect(b.locator("textarea").first()).toHaveValue("Then check the release notes on mobile");
    fail = false;
    await b.locator(".composer-queue-button").click();
    await expect(b.locator(".message-queue")).toContainText(copy.saved.replace("{{count}}", "1"));
    await b.getByRole("button", { name: (language === "en" ? en : language === "zh-CN" ? zhCN : zhTW).composer.stop, exact: true }).click();
    await expect(b.locator(".message-queue")).toContainText(("paused" in copy ? copy.paused : copy.paused_one).replace("{{count}}", "1"));
    await expect(a.locator(".message-queue")).toContainText(("paused" in copy ? copy.paused : copy.paused_one).replace("{{count}}", "1"));
    await b.getByRole("button", { name: copy.resume, exact: true }).click();
    await expect(b.locator(".message-queue")).toContainText(copy.saved.replace("{{count}}", "1"));
    for (const [name, page] of [["desktop", a], ["phone", b]] as const) {
      await expect(page.locator(".message-queue")).toBeVisible();
      const box = await page.locator(".message-queue").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.waitForTimeout(400);
      await page.screenshot({ path: info.outputPath(`queue-${theme}-${name}.png`) });
    }
    await laptop.close(); await phone.close();
  });
}
