import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve("web", path), "utf8");

describe("agent meta line", () => {
  it("names the runtime and every active computer in plain words", async () => {
    const source = await read("src/components/AgentMetaLine.tsx");

    assert.match(source, /agentLabel\(executorKind\)/);
    // Words only: a vendor glyph beside "Claude" and an ownership glyph beside
    // a computer's name said each fact twice on every row.
    assert.doesNotMatch(source, /<AgentMark\b/);
    assert.doesNotMatch(source, /<NodeOwnershipIcon\b/);
    // Every active placement, in route order — never just the first.
    assert.match(source, /descriptions\.map\(/);
    assert.doesNotMatch(source, /descriptions\[0\]/);
    // `removed` placements are filtered before anything is described.
    assert.match(source, /describeAgentPlacements\(activePlacements\(placements\)\)/);
  });

  it("shows the Runtime and model on the Agents list", async () => {
    const source = await read("src/components/AgentsPage.tsx");
    assert.match(source, /<AgentMetaLine\b[\s\S]*?executorKind=\{agent\.executorKind\}[\s\S]*?model=\{agentModel\(agent\)\}/);
  });

  it("keeps the meta line on one type rung across surfaces", async () => {
    const css = await read("src/styles/agent-meta.css").catch(() => read("src/styles/agents.css"));
    const rule = css.match(/\.agent-meta \{([^}]*)\}/)?.[1] ?? "";
    // --type-meta IS the 12px sentence-case caption rung (roles.css). This rule
    // used to spell `font: var(--type-label)` + `font-size: var(--fs-1)`, which
    // is the shape a missing role takes; asserting the role rather than the raw
    // token is the stronger check, since the role cannot drift a rung without
    // every other meta line drifting with it.
    assert.match(rule, /var\(--type-meta\)/);

    // The team surfaces used to redefine it a rung larger.
    for (const path of ["src/styles/teams.css", "src/styles/admin-v2-users.css"]) {
      const sheet = await read(path);
      assert.doesNotMatch(sheet, /\.team-(?:profile-member|member-option)-meta \{/, path);
    }
  });
});
