// Invoked by the Antigravity daemon integration test against its real backend.
import { chromium, expect } from "@playwright/test";

const [baseURL, thread, reply, permissionId] = process.argv.slice(2);
if (new URL(baseURL).hostname !== "127.0.0.1") throw new Error("Expected a disposable Relay backend");

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const login = await context.request.post("/api/v1/auth/login", {
    data: { username: "alice", password: "userpass" },
  });
  expect(login.ok()).toBe(true);
  await context.addInitScript(() => localStorage.setItem("relay-web.signedIn", "1"));
  const page = await context.newPage();
  await page.goto(`/threads/${thread}`);
  const transcript = page.locator(".msg-agent").filter({ hasText: reply });
  await expect(transcript.last()).toBeVisible({ timeout: 15_000 });
  await expect(transcript.last()).not.toContainText('"delta":true');
  const deny = page.locator(".permission-prompt").getByRole("button", { name: "Deny", exact: true });
  await expect(deny).toBeVisible();
  const decision = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().endsWith(`/permission-requests/${permissionId}`));
  await deny.click();
  expect((await decision).ok()).toBe(true);
  console.log("Chromium rendered the Antigravity reply and denied its ACP permission request.");
} finally {
  await browser.close();
}
