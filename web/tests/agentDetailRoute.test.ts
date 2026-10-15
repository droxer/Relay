import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("agent detail routing", () => {
  it("resolves the detail page from the route instead of the thread-scoped chat agent", async () => {
    // The signed-in tree moved out of the App auth gate into AuthenticatedApp.
    const source = await readFile(resolve("web/src/AuthenticatedApp.tsx"), "utf8");

    // A thread can be pinned to the cloud computer while the user inspects an
    // agent on their local computer. The page identity must therefore come
    // from /agents/:agentId, not activeLogicalAgent (the chat selection).
    assert.match(
      source,
      /const detailAgent = useMemo\(\s*\(\) => logicalAgents\.find\(\(agent\) => agent\.id === agentId\) \?\? null,/s,
    );
    assert.match(source, /detailAgent=\{detailAgent\}/);
    assert.doesNotMatch(source, /detailAgent=\{activeLogicalAgent\?\.id === agentId/);
  });
});
