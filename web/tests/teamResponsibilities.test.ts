import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve(path), "utf8");

describe("team member responsibility cards", () => {
  it("draws each member as an identity card: avatar, name, lead + role pills, meta line", async () => {
    const source = await read("web/src/components/TeamMemberCard.tsx");
    assert.match(source, /<article\s+className="team-work-member"[^>]*?role="group"/);
    assert.match(source, /<header className="team-work-member-head">\s*<AgentStateBadge/);
    assert.match(source, /imageUrl=\{member\.profileImageUrl\}/);
    assert.match(source, /<TonePill tone="info" label=\{t\("project\.lead_badge"\)\} \/>/);
    // The role pill shows the role the member will actually play, so an
    // inherited default is visible without opening the select.
    assert.match(source, /const role = effectiveRoleOf\(member, config\)/);
    assert.match(source, /<TonePill tone="neutral" label=\{t\(`team_work\.role_\$\{role\}`\)\} \/>/);
    assert.match(source, /<AgentMetaLine executorKind=\{member\.executorKind\} placements=\{member\.placements \?\? \[\]\} \/>/);
    // A responsibility is a sentence or two, not a single-line value.
    assert.match(source, /<Textarea\s+rows=\{2\}\s+value=\{config\.responsibility/);
  });

  it("keeps contract editing on the record's cards, not in the membership editors", async () => {
    const page = await read("web/src/components/TeamWorkspacePage.tsx");
    const drawer = await read("web/src/components/admin/TeamDrawer.tsx");
    // The read view is the card grid with inline edit, not the old row list.
    assert.match(page, /<TeamMemberCard\b/);
    assert.doesNotMatch(page, /className="team-profile-members"/);
    for (const source of [page, drawer]) {
      assert.doesNotMatch(source, /TeamResponsibilities|TeamMemberEditCard/);
    }
  });

  it("lays the cards out in the crew-tile card grammar", async () => {
    const css = await read("web/src/styles/teams.css");
    const grid = css.match(/\.team-work-members \{[^}]*\}/)?.[0] ?? "";
    const card = css.match(/\.team-work-member \{[^}]*\}/)?.[0] ?? "";
    assert.match(grid, /grid-template-columns: repeat\(auto-fill, minmax\(min\(300px, 100%\), 1fr\)\)/);
    assert.match(card, /background: var\(--surface-1\)/);
    assert.match(card, /border-radius: var\(--r-3\)/);
  });

  it("edits membership through one picker that marks the lead on its row", async () => {
    for (const path of [
      "web/src/components/admin/TeamDrawer.tsx",
      "web/src/components/TeamWorkspacePage.tsx",
    ]) {
      const source = await read(path);
      assert.match(source, /<TeamMemberPicker\b/, path);
      // No checkbox row per owned agent, and no separate lead select.
      assert.doesNotMatch(source, /TeamMemberOption|label=\{t\("teams\.lead"\)\}/, path);
    }
  });
});
