import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/* The app is a client-routed SPA behind next.config.ts's CLIENT_ROUTES
   fallback: any path the app router owns but the fallback omits hard-loads
   as a 404 (the /automations rename shipped exactly that). Pin the contract:
   every canonical and legacy path in appRoute.ts has a fallback entry. */
import { resolve } from "node:path";

const readWeb = (rel: string) => readFileSync(resolve("web", rel), "utf8");

/** Exact fallback paths, and the heads whose whole subtree falls back. */
function clientRoutes(): { exact: Set<string>; subtrees: Set<string> } {
  const source = readWeb("next.config.ts");
  const block = source.match(/const CLIENT_ROUTES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "CLIENT_ROUTES block not found in next.config.ts");
  const exact = new Set<string>();
  const subtrees = new Set<string>();
  for (const m of block[1].matchAll(/"(\/[a-z-]*?)(\/:path\*)?"/g)) {
    (m[2] ? subtrees : exact).add(m[1]);
  }
  return { exact, subtrees };
}

function covered(routePath: string, { exact, subtrees }: ReturnType<typeof clientRoutes>): boolean {
  if (exact.has(routePath)) return true;
  const head = `/${routePath.split("/")[1]}`;
  return head !== routePath && subtrees.has(head);
}

function appRoutePaths(): string[] {
  const source = readWeb(path.join("src", "lib", "appRoute.ts"));
  const work = source.match(/WORK_PATHS[^=]*= \{([\s\S]*?)\};/);
  const legacy = source.match(/LEGACY_INFRA_PATHS[^=]*= \{([\s\S]*?)\};/);
  const publicPages = source.match(/PUBLIC_PAGE_PATHS[^=]*= \{([\s\S]*?)\};/);
  assert.ok(work && legacy && publicPages, "route tables not found in appRoute.ts");
  const paths = [...work[1].matchAll(/: "(\/[^"]*)"/g)].map((m) => m[1]);
  paths.push(...[...legacy[1].matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]));
  // Signed-out pages an emailed link hard-loads.
  paths.push(...[...publicPages[1].matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]));
  // The legacy head aliases registered straight onto WORK_ROUTES.
  paths.push(...[...source.matchAll(/WORK_ROUTES\.set\("(\/[^"]*)"/g)].map((m) => m[1]));
  return paths;
}

describe("SPA fallback routes", () => {
  it("covers every canonical and legacy path the app router owns", () => {
    const routes = clientRoutes();
    const missing = appRoutePaths().filter((p) => !covered(p, routes));
    assert.deepEqual(missing, []);
  });
});
