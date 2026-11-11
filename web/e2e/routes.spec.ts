import { expect, test } from "@playwright/test";

const pages = [
  ["/home", "#home-panel"], ["/threads", "#thread-panel"], ["/threads/new", "form.composer"],
  ["/tasks", ".tasks-workspace"], ["/automations", ".routine-page"], ["/projects", "#thread-panel"],
  ["/agents", "#agents-panel"], ["/teams", "#teams-panel"], ["/computers", "#computer-panel"], ["/skills", "#skills-panel"],
  ...["account", "connections", "notifications", "appearance", "language"].map(section => [`/settings/${section}`, "#settings-panel"]),
  ...["dashboard", "users", "computers", "waitlist", "organization"].map(section => [`/admin/${section}`, "#admin-panel"]),
] as const;

// Exercise route mounting even when its data source is temporarily unavailable.
for (const [path, selector] of pages) {
  test(`direct route and reload mount ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith("/auth/me")) {
        return route.fulfill({ json: { authenticated: true, user: {
          id: "routes-user", userId: "routes-user", username: "routes", role: "admin", theme: "light", language: "en",
        } } });
      }
      return route.fulfill({ status: 503, json: { detail: "Route test: data temporarily unavailable" } });
    });
    await page.goto(path);
    await expect(page.locator(selector)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
    await page.reload();
    await expect(page.locator(selector)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const path of ["/login", "/waitlist", "/join", "/forgot-password", "/reset-password"]) {
  test(`public route remains signed out: ${path}`, async ({ page }) => {
    await page.route("**/api/**", route => route.fulfill({ json: { authenticated: false, enabled: true } }));
    await page.goto(path);
    await expect(page.locator(".login-screen")).toHaveAttribute("data-mode", path.slice(1));
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
  });
}

test("private deep links retain their destination through sign-in", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { authenticated: false } }));
  await page.goto("/computers/device%3Au%3Am/tasks/t?tab=artifacts&q=review");
  await expect(page).toHaveURL(url => url.pathname === "/login"
    && url.searchParams.get("returnTo") === "/computers/device%3Au%3Am/tasks/t?tab=artifacts&q=review");
});

test("unknown routes, disabled Channels and non-admin control panel routes recover deliberately", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: {
    authenticated: true, user: { id: "member", userId: "member", username: "member", role: "user", theme: "light", language: "en" },
    sessions: [], tasks: [], projects: [], agents: [], teams: [], nodes: [], skills: [], sandboxes: [], notifications: [],
  } }));
  for (const path of ["/unknown", "/channels", "/settings/unknown", "/computers/c/unknown"]) {
    await page.goto(path);
    await expect(page.locator("#route-not-found")).toBeVisible();
  }
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/threads$/);
  await expect(page.locator("#thread-panel")).toBeVisible();
});
