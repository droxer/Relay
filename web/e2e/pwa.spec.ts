import { expect, test } from "@playwright/test";

test("publishes an installable manifest and controls the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/threads");
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBeTruthy();
  const worker = await page.request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("javascript");
  const cached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith("relay-offline-"));
    return Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)));
  });
  expect(cached).toEqual([["/offline.html"]]);
});

test("opens deep links offline and retries the same URL after reconnecting", async ({ page, context }, testInfo) => {
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.goto("/threads/offline-test?space=1");
  await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
  expect(page.url()).toContain("/threads/offline-test?space=1");
  await page.screenshot({ path: testInfo.outputPath("offline.png"), fullPage: true });
  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "You’re offline" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
});

test("uses the saved language on the offline screen", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.setItem("relay-web.language", "zh-CN");
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "你已离线" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});
