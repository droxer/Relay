import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve(path), "utf8");

const SURFACES = [
  "web/src/components/assignment/AssignmentField.tsx",
  "web/src/components/composer/AgentSelect.tsx",
  "web/src/components/ProjectMemberEditor.tsx",
  "web/src/components/admin/TeamDrawer.tsx",
  "web/src/components/admin/ChannelDetail.tsx",
];

describe("shared roster picker", () => {
  it("is the one picker every agent/team surface opens", async () => {
    for (const path of SURFACES) {
      const source = await read(path);
      assert.match(source, /useRosterTabs/, `${path} does not use the shared roster tabs`);
      assert.match(source, /header=\{roster\.header\}/, `${path} does not render the shared strip`);
      assert.match(
        source,
        /onKeyDownCapture=\{roster\.onKeyDownCapture\}/,
        `${path} does not wire the roster keyboard contract`,
      );
      // Reopening lands on the roster the current value came from, so the
      // checked row is the one on screen.
      assert.match(source, /if \(open\) roster\.resetTab\(\)/, `${path} does not reopen on the active roster`);
    }
  });

  it("draws identity rows from the shared row components, not per-surface markup", async () => {
    for (const path of SURFACES.filter((entry) => !entry.endsWith("AgentSelect.tsx"))) {
      const source = await read(path);
      assert.match(source, /Roster(Agent|Team)Item|RosterOption/, `${path} hand-rolls its option rows`);
      assert.match(source, /RosterTriggerValue/, `${path} hand-rolls its closed trigger`);
    }
    // The composer keeps its own compact rows (availability chips, busy pip)
    // — it is a footer control, not a drawer field — so it shares the strip
    // and the keyboard contract without inheriting the drawer row geometry.
    const composer = await read("web/src/components/composer/AgentSelect.tsx");
    assert.match(composer, /className="chat-agent-option"/);
  });

  it("hides the strip when a surface has a single roster to offer", async () => {
    const tabs = await read("web/src/components/roster/RosterTabs.tsx");
    // One tab is not a choice: the header is null and the popup reads as any
    // other select.
    assert.match(tabs, /const tabbed = tabs\.length > 1;/);
    assert.match(tabs, /header: tabbed \?/);
    // With the strip gone, the tab state must not decide anything — the only
    // roster is read straight off the list.
    assert.match(tabs, /const current = tabbed \? tab : tabs\[0\]\?\.id \?\? activeTab;/);
    assert.match(tabs, /if \(!tabbed\) return;/);

    // Agents-only surfaces declare exactly one roster, so none of them renders
    // a lone tab.
    for (const path of [
      "web/src/components/ProjectMemberEditor.tsx",
      "web/src/components/admin/TeamDrawer.tsx",
      "web/src/components/admin/ChannelDetail.tsx",
    ]) {
      const source = await read(path);
      const declaration = source.match(/const rosterTabs: RosterTab<[^>]+>\[\] = \[[\s\S]*?\n {2}\];/);
      assert.ok(declaration, `${path} does not declare its rosters`);
      assert.equal((declaration[0].match(/\{ id: /g) ?? []).length, 1, `${path} declares more than one roster`);
    }
  });

  it("tabs the composer only while both rosters are on offer", async () => {
    const composer = await read("web/src/components/composer/AgentSelect.tsx");
    // Teams are pickable only while staging a non-project thread; a project
    // thread targets the room and its own members, which is one roster.
    assert.match(composer, /const teamsOffered = teamOptionsEnabled && teams\.length > 0;/);
    assert.match(composer, /label: t\("composer\.agents_group"\)/);
    assert.match(composer, /label: t\("composer\.teams_group"\)/);
    // The project room keeps its stacked groups, since there is no strip to
    // name its rosters.
    assert.match(composer, /composer\.project_group/);
    assert.match(composer, /composer\.project_members_group/);
  });

  it("keeps the roster styles in one shared sheet", async () => {
    const styles = await read("web/src/styles/roster-select.css");
    const taskDrawer = await read("web/src/styles/task-drawer.css");
    const entry = await read("web/src/styles.css");

    assert.match(entry, /@import "\.\/styles\/roster-select\.css" layer\(relay\);/);
    for (const rule of [".roster-tabs", ".roster-tab", ".roster-option", ".roster-trigger"]) {
      assert.ok(styles.includes(`${rule} {`), `roster-select.css is missing ${rule}`);
    }
    // The task drawer keeps only what is its own — the assignment summary —
    // so no surface inherits picker geometry through a task-named class.
    assert.doesNotMatch(taskDrawer, /\.task-assignment-(tab|option|trigger)/);
    assert.match(taskDrawer, /\.task-assignment-summary \{/);
  });
});
