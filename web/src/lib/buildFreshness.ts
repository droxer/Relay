import { hasNavigationGuards } from "./navigationGuard.ts";

/* An open tab keeps running the build it loaded; the page's HTML revalidates,
   but nothing reloads it. Each build publishes its id at /version.json (see
   src/app/version.json/route.ts) and carries the same id inlined, so a tab
   can ask whether it is still current. When it is not, the app offers a
   reload and turns the next move to another page into a full load. */

/** This build's id, inlined at build time by next.config.ts. Empty in tests. */
export const BUILD_ID = process.env.NEXT_PUBLIC_RELAY_BUILD_ID ?? "";
export const VERSION_PATH = "/version.json";
/** How often a visible tab asks, besides on focus. */
export const BUILD_CHECK_INTERVAL_MS = 10 * 60_000;
/** Focus and visibility can fire together; ask at most once per window. */
export const BUILD_CHECK_THROTTLE_MS = 60_000;

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

let stale = false;
const listeners = new Set<() => void>();

export function parseBuildId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { buildId?: unknown }).buildId;
  return typeof id === "string" && BUILD_ID_PATTERN.test(id) ? id : null;
}

export function isBuildStale(): boolean {
  return stale;
}

export function subscribeBuildStale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function markBuildStale(): void {
  if (stale) return;
  stale = true;
  for (const listener of [...listeners]) listener();
}

/** Back to a current build with no listeners; for tests. */
export function resetBuildFreshness(): void {
  stale = false;
  listeners.clear();
}

/** The deployed build's id, or null when it cannot be read (offline, an
    older deploy without the file, a proxy answering HTML). */
export async function fetchDeployedBuildId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(VERSION_PATH, { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    return parseBuildId(await response.json());
  } catch {
    return null;
  }
}

export interface BuildFreshnessCheckOptions {
  buildId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A throttled check that marks the build stale once a different one is
    deployed; resolves whether this tab is now known to be stale. */
export function createBuildFreshnessCheck({
  buildId = BUILD_ID,
  fetchImpl = (input, init) => fetch(input, init),
  now = Date.now,
}: BuildFreshnessCheckOptions = {}): () => Promise<boolean> {
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (!buildId) return false;
    if (stale) return true;
    const at = now();
    if (at - lastCheckAt < BUILD_CHECK_THROTTLE_MS) return false;
    lastCheckAt = at;
    const deployed = await fetchDeployedBuildId(fetchImpl);
    if (deployed && deployed !== buildId) markBuildStale();
    return stale;
  };
}

/** Ask when the tab comes back into view and every interval while it is
    visible. Production builds only: dev reloads itself. */
export function installBuildFreshnessWatch(
  check: () => Promise<boolean> = createBuildFreshnessCheck(),
  enabled: boolean = process.env.NODE_ENV === "production" && BUILD_ID !== "",
): () => void {
  if (!enabled || typeof window === "undefined") return () => undefined;
  const run = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", run);
  window.addEventListener("focus", run);
  const timer = window.setInterval(run, BUILD_CHECK_INTERVAL_MS);
  return () => {
    document.removeEventListener("visibilitychange", run);
    window.removeEventListener("focus", run);
    window.clearInterval(timer);
  };
}

/** A stale tab moving to another page loads it fresh, which is the moment
    nothing is lost: not for a same-page change (filters, search), not for a
    replacement (canonical URLs), and not while unsaved work would ask. */
export function shouldReloadOnNavigation(nextUrl: string, currentPathname: string, replace: boolean): boolean {
  if (!stale || replace || hasNavigationGuards()) return false;
  const nextPathname = nextUrl.split(/[?#]/, 1)[0];
  return nextPathname !== currentPathname;
}
