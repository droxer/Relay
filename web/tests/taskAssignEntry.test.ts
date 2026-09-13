import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Task assignment discoverability", () => {
  it("offers agent and team management actions inside the assignment picker", async () => {
    const drawerSource = await readFile(resolve("web/src/components/assignment/AssignmentField.tsx"), "utf8");

    assert.match(drawerSource, /__nav_agents__/);
    assert.match(drawerSource, /__nav_teams__/);
    assert.match(drawerSource, /navigateToAppPath\("\/agents"\)/);
    assert.match(drawerSource, /navigateToAppPath\("\/teams\?dialog=create"\)/);
    // Both rosters render even when empty, with explicit empty-state copy
    // instead of a silently missing tab.
    assert.match(drawerSource, /backlog\.no_agents_available/);
    assert.match(drawerSource, /backlog\.no_teams_available/);
    assert.match(drawerSource, /backlog\.manage_agents/);
    assert.match(drawerSource, /backlog\.create_team/);
    assert.doesNotMatch(drawerSource, /teamOptions\.length > 0 \?/);
  });

  it("splits agents and agent teams into tabs inside one dropdown", async () => {
    const pickerSource = await readFile(resolve("web/src/components/assignment/AssignmentField.tsx"), "utf8");
    const tabsSource = await readFile(resolve("web/src/components/roster/RosterTabs.tsx"), "utf8");
    const selectSource = await readFile(resolve("web/src/components/ui/select.tsx"), "utf8");
    const rosterStyles = await readFile(resolve("web/src/styles/roster-select.css"), "utf8");

    // One tab per roster, replacing the stacked group labels.
    assert.match(tabsSource, /role="tablist"/);
    assert.match(pickerSource, /id: "agents", label: t\("backlog\.agents_section"\)/);
    assert.match(pickerSource, /id: "teams", label: t\("backlog\.teams_section"\)/);
    assert.doesNotMatch(pickerSource, /<SelectLabel>/);
    // Only the active roster is listed, so neither can bury the other.
    assert.match(pickerSource, /roster\.tab === "agents" \? \(/);
    // The strip is chrome, not options: it renders outside the listbox.
    assert.match(selectSource, /header \? \([\s\S]{0,160}?data-slot="select-header"/);
    assert.match(pickerSource, /header=\{roster\.header\}/);
    // Focus stays on the listbox, so the tabs are out of the tab order and
    // the left/right arrows switch rosters.
    assert.match(tabsSource, /tabIndex=\{-1\}/);
    assert.match(pickerSource, /onKeyDownCapture=\{roster\.onKeyDownCapture\}/);
    assert.match(tabsSource, /event\.key === "ArrowRight"/);
    // Opening on the roster the current assignment came from.
    assert.match(pickerSource, /onOpenChange=\{\(open\) => \{\s*if \(open\) roster\.resetTab\(\);/);
    assert.match(rosterStyles, /\.roster-tab\[aria-selected="true"\]/);
  });

  it("lets the drawer open focused on the assignment picker", async () => {
    const drawerSource = await readFile(resolve("web/src/components/task-board/TaskDrawer.tsx"), "utf8");

    assert.match(drawerSource, /initialFocus\?: "title" \| "assignment"/);
    assert.match(drawerSource, /data-modal-initial-focus=\{initialFocus === "title" \? "" : undefined\}/);
    // The assignment control is the shared picker now, so the drawer hands it
    // the focus intent instead of stamping the attribute itself.
    assert.match(drawerSource, /autoFocus=\{initialFocus === "assignment"\}/);
    const pickerSource = await readFile(resolve("web/src/components/assignment/AssignmentField.tsx"), "utf8");
    assert.match(pickerSource, /data-modal-initial-focus=\{autoFocus \? "" : undefined\}/);
  });

  it("exposes a quick-assign action on backlog and routine cards and rows", async () => {
    const backlogSource = await readFile(resolve("web/src/components/BacklogPage.tsx"), "utf8");
    const routinesSource = await readFile(resolve("web/src/components/RoutinesPage.tsx"), "utf8");
    // The card and row renderers moved to task-board/{Backlog,Routine}Records
    // when the two pages were split; each page still owns the handler they call.
    const [backlogRecords, routineRecords] = await Promise.all([
      readFile(resolve("web/src/components/task-board/BacklogRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-board/RoutineRecords.tsx"), "utf8"),
    ]);

    for (const source of [backlogSource, routinesSource]) {
      assert.match(source, /onAssign: \(\) => assignTask\(task\)/);
      assert.match(source, /setAssignmentFocus\(true\)/);
      assert.match(source, /initialFocus=\{assignmentFocus \? "assignment" : "title"\}/);
    }
    for (const records of [backlogRecords, routineRecords]) {
      assert.match(records, /onAssign: \(\) => void/);
      assert.match(records, /backlog\.assign_task/);
    }
    // Both backlog views (board card + list row) carry the button.
    assert.equal(backlogRecords.match(/<NavAgents size=\{ICON\.sm\} \/>/g)?.length, 2);
    // Routines share one RoutineAssignButton across both views.
    assert.equal(routineRecords.match(/<RoutineAssignButton onAssign=\{onAssign\} \/>/g)?.length, 2);
  });

  it("navigates in-app paths through the shared navigation event", async () => {
    const appRouteSource = await readFile(resolve("web/src/lib/appRoute.ts"), "utf8");
    const routerSource = await readFile(resolve("web/src/hooks/useAppRouter.ts"), "utf8");

    assert.match(appRouteSource, /export function navigateToAppPath\(path: string\)/);
    assert.match(routerSource, /window\.addEventListener\(APP_NAVIGATION_EVENT, applyCurrentLocation\)/);
  });
});
