import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve(path), "utf8");

describe("team member responsibility cards", () => {
  it("draws each member as an identity card: avatar, name, lead + role pills, meta line", async () => {
    const source = await read("web/src/components/TeamMemberCard.tsx");
    assert.match(source, /<article className="team-work-member" role="group"/);
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

  it("shares one card anatomy between the edit forms and the team record", async () => {
    const responsibilities = await read("web/src/components/TeamResponsibilities.tsx");
    const page = await read("web/src/components/TeamWorkspacePage.tsx");
    assert.match(responsibilities, /<TeamMemberEditCard/);
    assert.doesNotMatch(responsibilities, /<AgentStateBadge|<Select\b/);
    // The read view is the card grid with inline edit, not the old row list.
    assert.match(page, /<TeamMemberCard\b/);
    assert.doesNotMatch(page, /className="team-profile-members"/);
  });

  it("lays the cards out in the crew-tile card grammar", async () => {
    const css = await read("web/src/styles/teams.css");
    const grid = css.match(/\.team-work-members \{[^}]*\}/)?.[0] ?? "";
    const card = css.match(/\.team-work-member \{[^}]*\}/)?.[0] ?? "";
    assert.match(grid, /grid-template-columns: repeat\(auto-fill, minmax\(min\(300px, 100%\), 1fr\)\)/);
    assert.match(card, /background: var\(--surface-1\)/);
    assert.match(card, /border-radius: var\(--r-3\)/);
  });

  it("picks the lead before the cards that badge it, on both edit surfaces", async () => {
    for (const path of [
      "web/src/components/admin/TeamDrawer.tsx",
      "web/src/components/TeamWorkspacePage.tsx",
    ]) {
      const source = await read(path);
      const lead = source.indexOf('label={t("teams.lead")}');
      const cards = source.indexOf("<TeamResponsibilities");
      assert.ok(lead > 0 && cards > lead, `${path} renders the responsibility cards before the lead picker`);
    }
  });
});
