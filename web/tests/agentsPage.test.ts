import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve("web", path), "utf8");

/**
 * The agent meta line — `[vendor glyph] runtime · [ownership glyph] computers`.
 *
 * The roster row, the team profile's member list, and the team member picker
 * each drew this by hand and had drifted on every property that makes it
 * legible: the team pair dropped the vendor glyph entirely, sat a type rung
 * larger, showed only the first computer, and kept `removed` placements the
 * roster had already filtered out. These tests fail if a surface grows its own
 * copy again.
 */
describe("agent meta line", () => {
  it("shows the runtime glyph and every active computer", async () => {
    const source = await read("src/components/AgentMetaLine.tsx");

    assert.match(source, /agentLabel\(executorKind\)/);
    assert.match(source, /<AgentMark agent=\{executorKind\}/);
    assert.match(source, /className="agent-meta-runtime-mark"/);
    // Every active placement, in route order — never just the first.
    assert.match(source, /descriptions\.map\(/);
    assert.doesNotMatch(source, /descriptions\[0\]/);
    // `removed` placements are filtered before anything is described.
    assert.match(source, /describeAgentPlacements\(activePlacements\(placements\)\)/);
  });

  it("is the one component every agent-bearing surface renders", async () => {
    for (const path of [
      "src/components/AgentsPage.tsx",
      // The team record draws its members through the shared member card.
      "src/components/TeamMemberCard.tsx",
      "src/components/TeamMemberPicker.tsx",
    ]) {
      const source = await read(path);
      assert.match(source, /<AgentMetaLine\b/, path);
      // No surface may re-derive the line's parts for itself.
      assert.doesNotMatch(source, /agentLabel\(/, path);
      assert.doesNotMatch(source, /nodeOwnershipIcon\(/, path);
    }
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
    for (const path of ["src/styles/teams.css", "src/styles/admin-v2-employees.css"]) {
      const sheet = await read(path);
      assert.doesNotMatch(sheet, /\.team-(?:profile-member|member-option)-meta \{/, path);
    }
  });
});
