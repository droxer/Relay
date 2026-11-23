// Invoked by the Antigravity daemon integration test against its real backend.
import { chromium, expect } from "@playwright/test";

const [baseURL, thread, reply, action, value] = process.argv.slice(2);
if (new URL(baseURL).hostname !== "127.0.0.1") throw new Error("Expected a disposable Relay backend");

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const context = await browser.newContext({ baseURL, locale: "en", serviceWorkers: "block" });
  const login = await context.request.post("/api/v1/auth/login", {
    data: { username: "alice", password: "userpass" },
  });
  expect(login.ok()).toBe(true);
  await context.addInitScript(() => localStorage.setItem("relay-web.signedIn", "1"));
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(`/threads/${thread}`);
  const transcript = page.locator(".msg-agent").filter({ hasText: reply });
  await expect(transcript.last()).toBeVisible({ timeout: 15_000 });
  await expect(transcript.last()).not.toContainText('"delta":true');
  if (action === "steer") {
    await page.locator("textarea[name=message]").fill(value);
    await page.getByRole("button", { name: /to queue for the next turn/ }).click();
    await page.getByRole("button", { name: "Send queued message 1 to the working agent now", exact: true }).click();
    const liveMessage = page.locator(".msg-user").filter({ hasText: value });
    await expect(liveMessage).toContainText("Sent while it worked");
  } else if (action === "deny") {
    const deny = page.locator(".permission-prompt").getByRole("button", { name: "Deny", exact: true });
    await expect(deny).toBeVisible();
    const decision = page.waitForResponse((response) => response.request().method() === "POST"
      && response.url().endsWith(`/permission-requests/${value}`));
    await deny.click();
    expect((await decision).ok()).toBe(true);
  } else {
    throw new Error(`Unknown browser test action: ${action}`);
  }
} finally {
  await browser.close();
}
