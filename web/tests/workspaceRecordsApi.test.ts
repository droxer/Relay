import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listProjectWorkspaceFiles, listTaskWorkspaceFiles, readProjectWorkspaceFile } from "../src/api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function serve(folders: Record<string, string[]>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "http://relay.test");
    const path = url.searchParams.get("path") ?? "";
    calls.push(path);
    return new Response(JSON.stringify({ projectId: "p", taskId: "t", path,
      exists: path in folders, entries: (folders[path] ?? []).map(name => ({
        name, path: `${path}/${name}`, kind: "directory", bytes: null, updatedAt: "2026-10-01T00:00:00Z",
      })),
    }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

for (const list of [
  (path: string) => listProjectWorkspaceFiles({ projectId: "p", path }),
  (path: string) => listTaskWorkspaceFiles({ taskId: "t", path }),
]) {
  test("Activity includes historical threads alongside migrated threads", async () => {
    serve({ ".threads": ["current", "both"], threads: ["old", "both"] });
    const result = await list(".threads");
    assert.deepEqual(result.entries.map(e => e.path).sort(), [".threads/both", ".threads/current", "threads/old"]);
    assert.equal(result.exists, true);
  });
  test("Activity opens legacy-only records without a new run", async () => {
    serve({ threads: ["old"] });
    const result = await list(".threads");
    assert.equal(result.exists, true);
    assert.equal(result.entries[0]?.path, "threads/old");
  });
  test("a partially migrated thread keeps legacy files reachable with their real preview path", async () => {
    const calls = serve({ ".threads/both": ["HANDOFF.md"], "threads/both": ["HANDOFF.md", "HANDOFF.json"] });
    const result = await list(".threads/both");
    assert.deepEqual(result.entries.map(e => e.path).sort(), [".threads/both/HANDOFF.md", "threads/both/HANDOFF.json"]);
    await readProjectWorkspaceFile({ projectId: "p", path: result.entries.find(e => e.name === "HANDOFF.json")!.path });
    assert.equal(calls.at(-1), "threads/both/HANDOFF.json");
  });
  test("ordinary file browsing makes a single request", async () => {
    const calls = serve({ artifacts: ["report.md"] });
    await list("artifacts");
    assert.deepEqual(calls, ["artifacts"]);
  });
}
