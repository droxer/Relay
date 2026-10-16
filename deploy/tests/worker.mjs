// Runs deploy/workers/worker.js against a stub ASSETS binding: the responses it
// builds must carry the `/*` block of _headers, which Cloudflare does not apply
// to them, and keep the app-shell line.
//   node deploy/tests/worker.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../workers/worker.js";

const headersFile = readFileSync(new URL("../workers/_headers", import.meta.url), "utf8");
const allPaths = headersFile.split(/\n(?=\S)/).find((block) => block.startsWith("/*\n"));
assert.ok(allPaths, "_headers has no /* block");
const expected = allPaths
  .split("\n")
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.split(/:\s*(.*)/s).slice(0, 2));
assert.ok(expected.length > 0, "the /* block of _headers is empty");

const requested = [];
const env = {
  ASSETS: {
    async fetch(request) {
      requested.push(new URL(request.url).pathname);
      return new Response("<html>shell</html>", { headers: { "Content-Type": "text/html" } });
    },
  },
};

function assertHeaders(response, label) {
  for (const [name, value] of expected) assert.equal(response.headers.get(name), value, `${label}: ${name}`);
}

const shell = await worker.fetch(new Request("https://web.example/threads/abc"), env);
assert.equal(shell.status, 200);
assert.equal(await shell.text(), "<html>shell</html>");
assert.deepEqual(requested, ["/"]);
assertHeaders(shell, "app shell");
assert.equal(shell.headers.get("Cache-Control"), "no-cache");
console.log("ok    a deep link gets the app shell with the _headers security headers");

const kept = await worker.fetch(new Request("https://web.example/agents"), {
  ASSETS: { fetch: async () => new Response("shell", { headers: { "Cache-Control": "public, max-age=0, must-revalidate" } }) },
});
assert.equal(kept.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
console.log("ok    the asset store's own Cache-Control is kept");

const missing = await worker.fetch(new Request("https://web.example/_next/static/missing.js"), env);
assert.equal(missing.status, 404);
assert.deepEqual(requested, ["/"]);
assertHeaders(missing, "missing asset");
assert.equal(missing.headers.get("Cache-Control"), "no-store");
console.log("ok    a missing asset is an uncached 404 with the security headers");

const installer = await worker.fetch(new Request("https://web.example/install.sh"), {
  ...env,
  RELAY_API_ORIGIN: "https://api.web.example",
});
assert.equal(installer.status, 302);
assert.equal(installer.headers.get("Location"), "https://api.web.example/install.sh");
assert.deepEqual(requested, ["/"]);
assertHeaders(installer, "installer redirect");
assert.equal(installer.headers.get("Cache-Control"), "no-store");
const legacyInstaller = await worker.fetch(new Request("https://web.example/computer/install.sh"), {
  ...env,
  RELAY_API_ORIGIN: "https://api.web.example",
});
assert.equal(legacyInstaller.headers.get("Location"), "https://api.web.example/computer/install.sh");
console.log("ok    the install script redirects to the API origin, uncached");
