import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve(path), "utf8");

const SURFACES = [
  "web/src/components/assignment/AssignmentField.tsx",
  "web/src/components/composer/AgentSelect.tsx",
  "web/src/components/ProjectMemberEditor.tsx",
  "web/src/components/TeamMemberPicker.tsx",
  "web/src/components/admin/ChannelDetail.tsx",
];

// Pickers that add an entity rather than hold one: the closed trigger is
// always the "Add …" placeholder, so there is no chosen value to render.
const ADD_ONLY_SURFACES = new Set(["web/src/components/TeamMemberPicker.tsx"]);

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
    for (const path of SURFACES) {
      const source = await read(path);
      assert.match(source, /Roster(Agent|Team)Item|RosterOption/, `${path} hand-rolls its option rows`);
      if (!ADD_ONLY_SURFACES.has(path)) {
        assert.match(source, /RosterTriggerValue/, `${path} hand-rolls its closed trigger`);
      }
    }
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
      "web/src/components/TeamMemberPicker.tsx",
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

  it("keeps entity names out of machine translation", async () => {
    const roster = await read("web/src/components/roster/RosterOption.tsx");
    // Agent and team names are user-chosen proper nouns; the browser must not
    // auto-translate them, in the menu rows and in the closed trigger alike.
    const triggers = roster.match(/roster-trigger-name" translate="no"/g) ?? [];
    assert.equal(triggers.length, 2, "both trigger branches must mark the name translate=no");
    assert.match(roster, /<span translate="no">\{agent\.displayName\}/);
    assert.match(roster, /<span translate="no">\{team\.name\}/);
  });

  it("lets a surface silence the trigger busy pulse without forking the row", async () => {
    const roster = await read("web/src/components/roster/RosterOption.tsx");
    const styles = await read("web/src/styles/roster-select.css");
    const composer = await read("web/src/components/composer/AgentSelect.tsx");
    const chat = await read("web/src/styles/chat.css");

    // The composer's running rail already announces the thread's activity, so
    // the trigger silences its busy pulse — through a prop the roster row
    // owns, never by a surface reaching into the chip's internals.
    assert.match(composer, /hideBusyPulse=\{running\}/);
    assert.match(roster, /roster-trigger--no-busy-pulse/);
    assert.match(styles, /\.roster-trigger--no-busy-pulse \.agent-state\.tone-info::after/);
    assert.doesNotMatch(chat, /\.agent-state\.tone-info::after/);
  });
});
