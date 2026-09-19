import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const configSource = () => readFile(resolve("web/next.config.ts"), "utf8");

describe("Next development API proxy", () => {
  it("proxies the versioned API and persisted profile media", async () => {
    const source = await configSource();

    assert.match(source, /source: "\/api\/:path\*", destination: `\$\{backendUrl\}\/api\/:path\*`/);
    assert.match(source, /source: "\/profile-images\/:path\*", destination: `\$\{backendUrl\}\/profile-images\/:path\*`/);
    assert.doesNotMatch(source, /backendUrl\}\/sessions/);
    assert.doesNotMatch(source, /backendUrl\}\/cp/);
  });

  it("serves only recognized clean browser routes through the SPA", async () => {
    const source = await configSource();

    // Every WORK_PATHS entry in web/src/lib/appRoute.ts needs a fallback here
    // or a direct load / refresh of that URL 404s in dev — which is how
    // /computer shipped: client-side nav worked, F5 did not.
    for (const route of ["login", "threads", "projects", "backlog", "settings", "routines", "agents", "teams", "channels", "admin"]) {
      assert.match(source, new RegExp(`"\\/${route}"`));
    }
    // Sections are path segments, so /settings/skills has to fall back too.
    assert.match(source, /"\/settings\/:path\*"/);
    assert.match(source, /"\/projects\/:path\*"/);
  });

  it("gives the hosted build the same proxy and SPA routes as dev", async () => {
    const source = await configSource();

    // A separately hosted build (RELAY_WEB_HOST=proxy) must reuse both route
    // lists rather than declaring its own: a fallback added for dev but not for
    // the hosted build is a 404 that only appears in production.
    assert.match(source, /RELAY_WEB_HOST === "proxy"/);
    assert.equal(source.match(/backendProxyRewrites\(\)/g)?.length, 2);
    assert.equal(source.match(/spaFallbackRewrites\(\)/g)?.length, 2);

    // The default build stays a static export for the backend to serve at /.
    assert.match(source, /output: "export"/);
  });
});
