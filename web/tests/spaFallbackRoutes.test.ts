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

function clientRouteHeads(): Set<string> {
  const source = readWeb("next.config.ts");
  const block = source.match(/const CLIENT_ROUTES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "CLIENT_ROUTES block not found in next.config.ts");
  const heads = new Set<string>();
  for (const m of block[1].matchAll(/"(\/[a-z-]*?)(\/:path\*)?"/g)) {
    heads.add(m[1]);
  }
  return heads;
}

function appRoutePaths(): string[] {
  const source = readWeb(path.join("src", "lib", "appRoute.ts"));
  const work = source.match(/WORK_PATHS[^=]*= \{([\s\S]*?)\};/);
  const legacy = source.match(/LEGACY_SECTION_PATHS[^=]*= \{([\s\S]*?)\};/);
  assert.ok(work && legacy, "route tables not found in appRoute.ts");
  const paths = [...work[1].matchAll(/: "(\/[^"]*)"/g)].map((m) => m[1]);
  paths.push(...[...legacy[1].matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]));
  // The legacy head aliases registered straight onto WORK_ROUTES.
  paths.push(...[...source.matchAll(/WORK_ROUTES\.set\("(\/[^"]*)"/g)].map((m) => m[1]));
  return paths;
}

describe("SPA fallback routes", () => {
  it("covers every canonical and legacy path the app router owns", () => {
    const heads = clientRouteHeads();
    // A nested legacy path (/settings/computers) is covered by its head's
    // `:path*` fallback; a bare one needs its own entry.
    const missing = appRoutePaths().filter((p) => !heads.has(p) && !heads.has(p.split("/").slice(0, 2).join("/")));
    assert.deepEqual(missing, []);
  });
});
