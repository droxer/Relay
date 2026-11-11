import { afterEach, expect, it, vi } from "vitest";
import { browserUrlForAppState, canonicalBrowserUrl, hrefForRoute, parseAppPath, pathForAppState, validatedReturnTo } from "../src/lib/appRoute";
import { taskWorkspaceHref } from "../src/lib/workspaceScope";
import type { RelayTaskListItem } from "../src/types";

const collections = {
  home: "/home", main: "/threads", projects: "/projects", backlog: "/tasks", routine: "/automations",
  agents: "/agents", teams: "/teams", computers: "/computers", skills: "/skills",
  settings: "/settings/notifications", admin: "/admin/dashboard",
} as const;

it.each(Object.entries(collections))("round trips the %s navigation destination", (route, path) => {
  expect(hrefForRoute(route as keyof typeof collections)).toBe(path);
  expect(parseAppPath(path).route).toBe(route);
  expect(parseAppPath(path).notFound).toBeUndefined();
});

const details = [
  "/threads/new", "/threads/a%2Fb", "/projects/a%2Fb", "/projects/a%2Fb/new", "/projects/p/threads/a%2Fb",
  "/tasks/a%2Fb", "/tasks/t/threads/a%2Fb", "/automations/a%2Fb", "/automations/a/runs/a%2Fb",
  "/agents/a%2Fb", "/teams/a%2Fb", "/skills/a%2Fb",
  ...["account", "connections", "notifications", "appearance", "language"].map(section => `/settings/${section}`),
  ...["dashboard", "users", "computers", "waitlist", "organization"].map(section => `/admin/${section}`),
  ...["threads", "threads/new", "threads/a%2Fb", "tasks", "tasks/a%2Fb", "tasks/t/threads/a%2Fb", "automations", "automations/a%2Fb", "automations/a/runs/a%2Fb"].map(path => `/computers/device%3Au%3Am/${path}`),
];
it.each(details)("round trips deep link %s", path => {
  const state = parseAppPath(path);
  expect(state.notFound).toBeUndefined();
  expect(pathForAppState(state)).toBe(path);
  const canonical = canonicalBrowserUrl(path, "?tab=definition&space=1&artifact=a&q=review&page=2&unexpected=discard");
  const url = new URL(canonical, "http://relay.local");
  expect(canonicalBrowserUrl(url.pathname, url.search)).toBe(canonical);
  expect(url.searchParams.has("unexpected")).toBe(false);
});

it.each(["/unknown", "/agents/a/unknown", "/teams/a/unknown", "/projects/p/unknown", "/settings/unknown", "/admin/unknown", "/automations/a/runs/r/unknown", "/computers/c/settings", "/computers/c/projects", "/computers/c/tasks/t/unknown"])("rejects unsupported route %s", path => {
  expect(parseAppPath(path).notFound).toBe(true);
});

it.each(["/login", "/waitlist", "/join", "/forgot-password", "/reset-password"])("recognizes public route %s and prevents a sign-in return loop", path => {
  expect(parseAppPath(path).notFound).toBeUndefined();
  expect(validatedReturnTo(path)).toBe("/home");
});

it("keeps the team roster search when opening and closing a team", () => {
  expect(browserUrlForAppState(parseAppPath("/teams/team"), "/teams", "?q=release")).toBe("/teams/team?q=release");
  expect(browserUrlForAppState(parseAppPath("/teams"), "/teams/team", "?q=release&tab=activities")).toBe("/teams?q=release");
});

it("links unplaced work to its global record without choosing a Computer", () => {
  const task = { id: "unplaced" } as RelayTaskListItem;
  expect(taskWorkspaceHref(task, null)).toBe("/tasks/unplaced");
  expect(taskWorkspaceHref({ ...task, isRoutine: true }, null)).toBe("/automations/unplaced");
  expect(taskWorkspaceHref({ ...task, id: "run", sourceRoutineId: "auto" }, null)).toBe("/automations/auto/runs/run");
});

afterEach(() => vi.unstubAllEnvs());
it("retains the selected channel when Channels is enabled", async () => {
  vi.stubEnv("NEXT_PUBLIC_RELAY_CHANNELS_ENABLED", "1");
  vi.resetModules();
  const routes = await import("../src/lib/appRoute");
  expect(routes.parseAppPath("/channels").notFound).toBeUndefined();
  expect(routes.canonicalBrowserUrl("/channels", "?channel=chat-one")).toBe("/channels?channel=chat-one");
});
