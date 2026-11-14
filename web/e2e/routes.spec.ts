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
    // WebKit reports the requests a reload cancels as "… due to access control
    // checks" page errors; they are the browser tearing down the old page, not
    // the route failing to mount.
    page.on("pageerror", error => { if (!/due to access control checks/.test(error.message)) errors.push(error.message); });
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

// Keep URL, shell navigation, and rail contents in one test: checking each
// component separately missed a retained selection changing /projects to Threads.
const routeStamp = "2026-11-11T00:00:00.000Z";
const routeProjects = ["launch", "other"].map(id => ({
  id, name: id === "launch" ? "Route launch" : "Other project", ownerUserId: "routes-user",
  computerId: "route-computer", enabled: true, members: [], leadAgentId: null,
  version: 1, createdAt: routeStamp, updatedAt: routeStamp,
}));
const routeThreads = [
  ["chat", null], ["task", null], ["automation", null],
  ["project-chat", "launch"], ["project-task", "launch"], ["project-automation", "launch"],
  ["other-chat", "other"],
].map(([id, projectId]) => ({
  id: id!, title: `Route ${id}`, taskGoal: `Route ${id}`, projectId,
  computerId: "route-computer", ownerUserId: "routes-user", participants: ["human"],
  status: "completed", phase: "completed", createdAt: routeStamp, updatedAt: routeStamp,
  agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [],
  eventCount: 0, artifactCount: 0, runCount: 0,
}));
const routeTasks = ["task", "automation", "project-task", "project-automation"].map(id => ({
  id: `task-${id}`, title: `Origin ${id}`, description: "", priority: "normal", status: "done",
  projectId: id.startsWith("project-") ? "launch" : null, computerId: "route-computer",
  isRoutine: false, ...(id.includes("automation") ? { sourceRoutineId: `parent-${id}` } : {}),
  linkedSessionIds: [id], ownerUserId: "routes-user", createdAt: routeStamp, updatedAt: routeStamp,
}));

async function serveRouteWork(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    let body: unknown = {
      sessions: routeThreads, tasks: routeTasks, projects: routeProjects, agents: [], teams: [],
      nodes: [{ id: "route-node", computerId: "route-computer", userId: "routes-user", status: "ready", online: true, stale: false, activeRuns: [], agents: {} }],
      sandboxes: [], skills: [], notifications: [], files: [], entries: [], hasMore: false,
    };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: {
      id: "routes-user", userId: "routes-user", username: "Routes", role: "user", theme: "light", language: "en",
    } };
    const thread = routeThreads.find(item => path.endsWith(`/threads/${item.id}`));
    if (thread) body = thread;
    const project = routeProjects.find(item => path.endsWith(`/projects/${item.id}`));
    if (project) body = { project };
    const task = routeTasks.find(item => path.endsWith(`/tasks/${item.id}`));
    if (task) body = { ...task, events: [], activity: [] };
    await route.fulfill({ json: body });
  });
}

const routeSurfaces = [
  { path: "/projects", title: "Projects", selected: "projects", rows: 0, folders: 2 },
  { path: "/projects/launch", title: "Projects", selected: "projects", rows: 0, folders: 2 },
  { path: "/projects/launch/threads/project-task", title: "Threads", selected: "threads", rows: 7, folders: 0 },
  { path: "/projects/launch/threads/project-automation", title: "Threads", selected: "threads", rows: 7, folders: 0 },
  { path: "/projects/launch/new", title: "Threads", selected: "threads", rows: 7, folders: 0 },
  { path: "/threads", title: "Threads", selected: "threads", rows: 7, folders: 0 },
  { path: "/computers/route-computer/threads/task", title: "Threads", selected: "threads", rows: 7, folders: 0 },
  { path: "/computers/route-computer/threads/automation", title: "Threads", selected: "threads", rows: 7, folders: 0 },
] as const;

for (const mobile of [false, true]) {
  for (const surface of routeSurfaces) {
    test(`route rail and sidebar survive reload: ${surface.path} (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await serveRouteWork(page);
      await page.goto(surface.path);
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        await expect(page).toHaveURL(url => url.pathname === surface.path);
        const rail = page.locator("#thread-panel");
        await expect(rail.locator("h2.page-header-title")).toHaveText(surface.title);
        await expect(rail.locator(".conversation-row")).toHaveCount(surface.rows);
        await expect(rail.locator(".project-folder")).toHaveCount(surface.folders);
        await expect(page.locator(`.sidenav-nav [data-nav="${surface.selected}"]`)).toHaveAttribute("aria-current", "page");
        await expect(page.locator('.sidenav-nav [aria-current="page"]')).toHaveCount(1);
        if (surface.rows === 7) {
          await expect(rail.locator(".conversation-name")).toHaveText(routeThreads.map(thread => thread.title));
        }
        if (surface.selected === "threads") {
          await expect(rail.locator(".computer-workspace-nav")).toHaveCount(0);
          await expect(rail.locator('[name="thread-project-filter"]')).toHaveCount(1);
          await expect(page.locator('.messenger-shell')).toHaveAttribute("data-route", "main");
        }
      }
    });
  }
}

// These three drive the desktop shell — the side nav and the rail's own New
// thread button, which a phone moves into its top bar — so the phone projects
// skip them; the recovery suite runs them on desktop.
const DESKTOP_SHELL = "drives the desktop side nav and rail header";

test("project thread, Projects link, and browser history keep their matching lists", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_SHELL);
  await serveRouteWork(page);
  await page.goto("/threads");
  await page.locator("#thread-panel .conversation-row-inner").filter({ hasText: "Route project-task" }).click();
  await expect(page).toHaveURL(/\/projects\/launch\/threads\/project-task$/);
  await expect(page.locator('#thread-panel .conversation-row')).toHaveCount(7);
  await page.locator('.sidenav-nav [data-nav="projects"]').click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator('#thread-panel h2.page-header-title')).toHaveText("Projects");
  await expect(page.locator('#thread-panel .project-folder')).toHaveCount(2);
  await expect(page.locator('#thread-panel .conversation-row')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('#thread-panel h2.page-header-title')).toHaveText("Threads");
  await expect(page.locator('.sidenav-nav [data-nav="threads"]')).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page.locator('#thread-panel h2.page-header-title')).toHaveText("Projects");
  await page.locator(".project-folder-select").filter({ hasText: "Route launch" }).click();
  await expect(page).toHaveURL(/\/projects\/launch$/);
  await expect(page.getByRole("tab", { name: "Dashboard", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("project thread creation and mobile Back stay in Threads", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_SHELL);
  await serveRouteWork(page);
  await page.goto("/projects/launch/threads/project-task");
  // Until the list loads, the rail's empty state offers a second New thread.
  await expect(page.locator("#thread-panel .conversation-row")).toHaveCount(7);
  await page.locator("#thread-panel").getByRole("button", { name: "New thread", exact: true }).click();
  await expect(page).toHaveURL(/\/threads\/new$/);
  await expect(page.locator('#thread-panel h2.page-header-title')).toHaveText("Threads");
  await expect(page.locator('.sidenav-nav [data-nav="threads"]')).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/projects/launch/threads/project-automation");
  await page.locator(".mobile-topbar-back").click();
  await expect(page).toHaveURL(/\/threads$/);
  await expect(page.locator("#thread-panel")).toBeVisible();
  await expect(page.locator('#thread-panel .conversation-row')).toHaveCount(7);
});

test("all thread routes share list controls, geometry, search and creation", async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, DESKTOP_SHELL);
  await serveRouteWork(page);
  let baseline: unknown;
  for (const path of ["/threads", "/projects/launch/threads/project-task", "/computers/route-computer/threads/task"]) {
    await page.goto(path);
    const rail = page.locator("#thread-panel");
    await expect(rail.locator(".conversation-row")).toHaveCount(7);
    await expect(rail.locator('.conversation-group[data-tone="idle"] .conversation-group-label')).toHaveCount(0);
    const layout = await rail.evaluate(element => {
      const style = (selector: string) => {
        const node = selector === ".conversation-row"
          ? element.querySelector('strong[title="Route other-chat"]')!.closest("li")!
          : element.querySelector(selector)!;
        const css = getComputedStyle(node);
        return { height: node.getBoundingClientRect().height, padding: css.padding,
          fontSize: css.fontSize, background: css.backgroundColor, gap: css.gap };
      };
      return { header: style(".page-header"), filters: style(".list-filter-bar"), row: style(".conversation-row") };
    });
    if (baseline) expect(layout).toEqual(baseline);
    else baseline = layout;
    await rail.screenshot({ path: testInfo.outputPath(`${path.includes("projects") ? "project" : path.includes("computers") ? "task" : "global"}-thread-list.png`) });
    const projectFilter = rail.locator('[name="thread-project-filter"]');
    await projectFilter.click();
    await expect(page.getByRole("option")).toHaveText(["All threads", "Other project", "Route launch"]);
    await page.getByRole("option", { name: "Route launch", exact: true }).click();
    await expect(rail.locator(".conversation-row")).toHaveCount(3);
    await projectFilter.click();
    await page.getByRole("option", { name: "All threads", exact: true }).click();
    await expect(rail.locator(".conversation-row")).toHaveCount(7);
    const search = rail.locator('input[name="thread-search"]');
    await search.fill("Route automation");
    await expect(rail.locator(".conversation-name")).toHaveText(["Route automation"]);
    await search.fill("");
    await expect(rail.locator(".conversation-row")).toHaveCount(7);
    await rail.getByRole("button", { name: "New thread", exact: true }).click();
    await expect(page).toHaveURL(/\/threads\/new$/);
  }
});
