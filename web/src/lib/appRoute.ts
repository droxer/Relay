import { requestNavigation } from "./navigationGuard.ts";
import type { AppRoute, MobileView } from "./viewTypes.js";

const WORK_PATHS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  backlog: "/backlog",
  routine: "/routines",
  agents: "/agents",
  teams: "/teams",
  channels: "/channels",
  admin: "/admin",
  computer: "/computer",
};

const WORK_ROUTES = new Map(Object.entries(WORK_PATHS).map(([route, path]) => [path, route as AppRoute]));

export const APP_NAVIGATION_EVENT = "relay:navigation";

export type AppLocationState = {
  route: AppRoute;
  mobileView: MobileView;
  sessionId: string | null;
  projectId?: string | null;
  agentId?: string | null;
  teamWorkspaceId?: string | null;
  composingNew?: boolean;
  login?: boolean;
  notFound?: boolean;
};

function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

export function parseAppPath(pathname: string, _search = ""): AppLocationState {
  const normalized = pathname === "/" ? "/threads" : `/${pathSegments(pathname).join("/")}`;
  const [head, second, ...rest] = pathSegments(normalized);
  const base = { mobileView: "chat" as const, sessionId: null };

  if (normalized === "/login") return { route: "main", ...base, login: true };
  if (normalized === "/threads") return { route: "main", mobileView: "threads", sessionId: null };
  if (head === "threads" && second === "new" && rest.length === 0) {
    return { route: "main", ...base, composingNew: true };
  }
  if (head === "threads" && second && rest.length === 0) {
    return { route: "main", ...base, sessionId: decodeSegment(second) };
  }
  if (head === "projects" && !second && rest.length === 0) {
    return { route: "projects", mobileView: "threads", sessionId: null };
  }
  if (head === "projects" && second && rest.length === 0) {
    return { route: "projects", mobileView: "chat", sessionId: null, projectId: decodeSegment(second) };
  }
  if (head === "projects" && second && rest[0] === "new" && rest.length === 1) {
    return { route: "projects", ...base, projectId: decodeSegment(second), composingNew: true };
  }
  if (head === "projects" && second && rest[0] === "threads" && rest[1] && rest.length === 2) {
    return { route: "projects", ...base, projectId: decodeSegment(second), sessionId: decodeSegment(rest[1]) };
  }
  if (head === "agents" && second && rest.length === 0) {
    return { route: "agents", ...base, agentId: decodeSegment(second) };
  }
  if (head === "teams" && second && rest.length === 0) {
    return { route: "teams", ...base, teamWorkspaceId: decodeSegment(second) };
  }
  const workRoute = WORK_ROUTES.get(normalized);
  if (workRoute) return { route: workRoute, ...base };
  return { route: "main", ...base, notFound: true };
}

export function pathForAppState({
  route,
  mobileView,
  sessionId,
  projectId,
  agentId,
  teamWorkspaceId,
  composingNew,
  login,
  notFound,
}: AppLocationState): string {
  if (notFound && typeof window !== "undefined") return window.location.pathname;
  if (login) return "/login";
  if (route === "agents" && agentId) return `/agents/${encodeURIComponent(agentId)}`;
  if (route === "teams" && teamWorkspaceId) return `/teams/${encodeURIComponent(teamWorkspaceId)}`;
  if (route === "projects") {
    if (!projectId) return "/projects";
    const projectPath = `/projects/${encodeURIComponent(projectId)}`;
    if (mobileView === "threads") return projectPath;
    if (composingNew) return `${projectPath}/new`;
    return sessionId ? `${projectPath}/threads/${encodeURIComponent(sessionId)}` : projectPath;
  }
  if (route !== "main") return WORK_PATHS[route];
  if (mobileView === "threads") return "/threads";
  if (composingNew) return "/threads/new";
  return sessionId ? `/threads/${encodeURIComponent(sessionId)}` : "/threads";
}

export function hrefForRoute(route: AppRoute, sessionId?: string | null): string {
  return pathForAppState({
    route,
    mobileView: (route === "main" || route === "projects") && !sessionId ? "threads" : "chat",
    sessionId: route === "main" ? sessionId ?? null : null,
  });
}

const AGENT_TABS = new Set(["profile", "activities"]);
const TEAM_TABS = new Set(["profile", "activities"]);
const PROJECT_TABS = new Set(["profile", "workspace", "activities"]);
const AGENT_AVAILABILITY = new Set(["ready", "busy", "pending", "offline"]);

/**
 * Sort keys each list path owns, by the query param the table writes.
 *
 * Registered here for the same reason `?space=1` is: a param the path does
 * not own is canonicalized straight back out, so a column header would toggle
 * its caret and reorder nothing. The values are validated too — an unknown
 * key would render a header with no active column while sorting nothing (see
 * `parseSortParam`), so a stale link is dropped rather than half-honoured.
 * Keep in sync with each surface's `SortColumn` set.
 */
const LIST_SORT_PARAMS: Record<string, Record<string, ReadonlySet<string>>> = {
  backlog: { sort: new Set(["title", "status", "priority", "assignee", "due"]) },
  routines: { sort: new Set(["title", "state", "priority", "assignee", "nextRun"]) },
  // Two tables on one path, so each owns its own key.
  admin: {
    employeeSort: new Set(["employee", "computers", "localLimit", "running", "ready"]),
    nodeSort: new Set(["node", "employee", "runtimes"]),
  },
};

/**
 * Page params each list path owns. Registered for the same reason as the sort
 * keys above: without an entry the pager would advance its own highlight and
 * then render page 1, because the param never survives the write.
 */
const LIST_PAGE_PARAMS: Record<string, readonly string[]> = {
  // `lanes` is the grouped cursor set, not a page number — see
  // LANE_PAGE_PATHS below. `backlog` keeps `page` for old links; nothing
  // writes it now that the list groups.
  backlog: ["page"],
  routines: ["page"],
  computer: ["page"],
  // Two paged collections on one path, so each owns its own key.
  admin: ["employeePage", "nodePage"],
};

/**
 * Per-group cursor sets each path owns, by the query param the grouped list
 * writes. Kept opaque here: `parseLanePages` drops unknown groups and
 * non-pages on read, so this only has to decide whether the path owns the
 * key at all — the valid group names are task statuses, routine states, and
 * fleet health, and they belong to lib/backlog, lib/routine, and
 * lib/adminHelpers respectively.
 *
 * /admin has two grouped lists on one path, so each owns its own key — same
 * reason `employeePage`/`nodePage` are split below.
 */
const LANE_PAGE_PARAMS: Record<string, readonly string[]> = {
  backlog: ["lanes"],
  routines: ["lanes"],
  admin: ["employeeLanes", "nodeLanes"],
};

/**
 * Filter params each list path owns, by the query param the filter bar
 * writes. Registered for the same reason as the sort keys above: without an
 * entry the bar would rewrite the URL and canonicalization would strip its
 * params straight back out. `null` marks a free-text field, copied verbatim;
 * a set lists the enum values that survive, so a stale or hand-edited link
 * cannot force a filter the bar cannot display. Keep in sync with each
 * surface's `FilterSpec`.
 */
const LIST_FILTER_PARAMS: Record<string, Record<string, ReadonlySet<string> | null>> = {
  backlog: {
    q: null,
    status: new Set(["backlog", "assigned", "running", "waiting_for_human", "review", "blocked", "done"]),
    priority: new Set(["high", "normal", "low"]),
    agent: null,
    assignee: null,
    due: new Set(["overdue", "today", "unscheduled"]),
    source: new Set(["direct", "routine"]),
  },
  routines: {
    q: null,
    type: new Set(["task", "job"]),
    cadence: new Set(["daily", "weekly", "monthly", "custom"]),
    agent: null,
    assignee: null,
    state: new Set(["running", "overdue", "due", "scheduled", "unscheduled", "paused"]),
  },
};

/** Copies `?page=n` only for a path that pages, and only for a real page. */
function copyPageParams(head: string, source: URLSearchParams, target: URLSearchParams): void {
  for (const param of LANE_PAGE_PARAMS[head] ?? []) copyParam(source, target, param);
  for (const param of LIST_PAGE_PARAMS[head] ?? []) {
    const value = source.get(param);
    // Page 1 is the default and carries no param, so the URL never advertises
    // a page the reader is not on. Anything else `parsePageParam` would floor
    // to 1 is dropped rather than echoed back.
    if (value && /^\d+$/.test(value) && Number(value) > 1) target.set(param, value);
  }
}

/** Copies `?sort=key` / `?sort=-key` only when the path declares that key. */
function copySortParams(head: string, source: URLSearchParams, target: URLSearchParams): void {
  const owned = LIST_SORT_PARAMS[head];
  if (!owned) return;
  for (const [param, keys] of Object.entries(owned)) {
    const value = source.get(param);
    if (!value) continue;
    const key = value.startsWith("-") ? value.slice(1) : value;
    if (keys.has(key)) target.set(param, value);
  }
}

function copyParam(source: URLSearchParams, target: URLSearchParams, key: string): void {
  const value = source.get(key);
  if (value) target.set(key, value);
}

/** Copies filter params only for a path that owns them, dropping enum values
 *  the filter cannot take. */
function copyFilterParams(head: string, source: URLSearchParams, target: URLSearchParams): void {
  const owned = LIST_FILTER_PARAMS[head];
  if (!owned) return;
  for (const [param, allowed] of Object.entries(owned)) {
    const value = source.get(param);
    if (!value) continue;
    if (allowed && !allowed.has(value)) continue;
    target.set(param, value);
  }
}

/** Returns only query parameters owned by the current route and tab. */
export function canonicalSearchForPath(pathname: string, search = ""): string {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  const [head, entityId, ...rest] = pathSegments(pathname);

  if (head === "login" && !entityId) {
    const rawReturnTo = source.get("returnTo");
    if (rawReturnTo) target.set("returnTo", validatedReturnTo(rawReturnTo));
  } else if (
    (head === "threads" && entityId !== "new" && rest.length === 0)
    || (head === "projects" && Boolean(entityId) && rest[0] === "threads" && Boolean(rest[1]) && rest.length === 2)
  ) {
    // The thread space panel is URL-driven (?space=1&artifact=<id>) so an open
    // panel survives reload and can be shared. The selection only means
    // something while the panel is open.
    // The bare /threads path owns these too: on desktop it still shows a
    // thread (the most recent one, picked as the fallback), so the panel can
    // be opened from there. Dropping the params on that path made the toggle
    // write space=1 and have it canonicalized straight back out — a click
    // that did nothing at all. Only /threads/new has no thread to describe.
    if (source.get("space") === "1") {
      target.set("space", "1");
      copyParam(source, target, "artifact");
    }
  } else if (head === "projects" && entityId && rest.length === 0) {
    const tab = source.get("tab") || "profile";
    if (PROJECT_TABS.has(tab) && tab !== "profile") target.set("tab", tab);
    if (tab === "workspace") {
      copyParam(source, target, "path");
      copyParam(source, target, "item");
    }
  } else if (head === "agents" && !entityId) {
    copyParam(source, target, "q");
    const availability = source.get("availability");
    if (availability && AGENT_AVAILABILITY.has(availability)) {
      target.set("availability", availability);
    }
  } else if (head === "agents" && entityId && rest.length === 0) {
    const requestedTab = source.get("tab");
    const tab = requestedTab && AGENT_TABS.has(requestedTab) ? requestedTab : "profile";
    if (tab !== "profile") target.set("tab", tab);
  } else if (head === "teams" && !entityId) {
    if (source.get("dialog") === "create") target.set("dialog", "create");
  } else if (head === "teams" && entityId && rest.length === 0) {
    const requestedTab = source.get("tab");
    const tab = requestedTab && TEAM_TABS.has(requestedTab) ? requestedTab : "profile";
    if (tab !== "profile") target.set("tab", tab);
    // The add-team drawer can open over a selected team's profile. Retain its
    // URL-backed state instead of immediately canonicalizing the click away.
    if (source.get("dialog") === "create") target.set("dialog", "create");
  } else if (!entityId) {
    copySortParams(head, source, target);
    copyPageParams(head, source, target);
    copyFilterParams(head, source, target);
  }

  const encoded = target.toString();
  return encoded ? `?${encoded}` : "";
}

export function canonicalBrowserUrl(pathname: string, search = ""): string {
  return `${pathname}${canonicalSearchForPath(pathname, search)}`;
}

/** Whether `?space=1` survives on this path. A surface that writes a search
 *  param the path does not own gets it canonicalized straight back out, so
 *  the write silently does nothing — assert ownership here rather than
 *  discovering it as a dead control. */
export function pathKeepsThreadSpaceParams(pathname: string): boolean {
  return canonicalSearchForPath(pathname, "?space=1") !== "";
}

export function validatedReturnTo(value: string | null, origin = "http://relay.local"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/threads";
  try {
    const candidate = new URL(value, origin);
    if (candidate.origin !== origin) return "/threads";
    const state = parseAppPath(candidate.pathname, candidate.search);
    if (state.notFound || state.login) return "/threads";
    return canonicalBrowserUrl(candidate.pathname, candidate.search);
  } catch {
    return "/threads";
  }
}

/**
 * The browser URL a state change should land on.
 *
 * Staying on the same path keeps that path's own canonical params: the thread
 * space panel is URL-driven (`?space=1&artifact=…`), so a send inside an open
 * thread — the team-room case, where artifacts pile up — must not silently
 * close the panel. Moving to a different path starts clean, because an
 * artifact selection only describes the thread it came from.
 */
export function browserUrlForAppState(
  state: AppLocationState,
  currentPathname: string,
  currentSearch = "",
): string {
  const nextPath = pathForAppState(state);
  return nextPath === currentPathname ? canonicalBrowserUrl(nextPath, currentSearch) : nextPath;
}

export function syncAppStateToUrl(state: AppLocationState, replace = false, onCommit?: () => void): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const nextUrl = browserUrlForAppState(state, window.location.pathname, window.location.search);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) {
    onCommit?.();
    return Promise.resolve();
  }
  return requestNavigation(() => {
    onCommit?.();
    window.history[replace ? "replaceState" : "pushState"]({ ...window.history.state, relayRoute: state }, "", nextUrl);
    window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
  });
}

/** Push an in-app path (search params allowed) and notify route/search listeners. */
export function navigateToAppPath(path: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return requestNavigation(() => {
    window.history.pushState(window.history.state, "", path);
    window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
  });
}
