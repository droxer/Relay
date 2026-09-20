import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(`web/src/${path}`, "utf8");
}

const backlogPage = source("components/BacklogPage.tsx");
const routinesPage = source("components/RoutinesPage.tsx");
const routineChrome = source("components/task-board/RoutineChrome.tsx");
const backlogRecords = source("components/task-board/BacklogRecords.tsx");
const routineRecords = source("components/task-board/RoutineRecords.tsx");
const taskDrawer = source("components/task-board/TaskDrawer.tsx");
const taskDrawerStyles = source("styles/task-drawer.css");
const listSortStyles = source("styles/list-sort.css");

describe("task board review regressions", () => {
  it("hydrates persisted views after the deterministic first render", () => {
    assert.match(backlogPage, /useState<BacklogView>\("board"\)/);
    assert.match(backlogPage, /useEffect\(\(\) => \{\s*setView\(parseBacklogView\(null\)\)/);
  });

  it("limits backlog selection to records rendered on current lane pages", () => {
    assert.match(backlogPage, /const visibleTasks = TASK_FLOW_STAGES\.flatMap\(\(status\) => pagedLanes\[status\]\.items\)/);
    assert.doesNotMatch(backlogPage, /const visibleTasks = view === "list"[\s\S]{0,120}: filteredTasks/);
  });

  it("keeps card actions off the tile and always visible in the peek", () => {
    // The hover-revealed card action bar is gone — it hid the card's own
    // facts on hover and vanished entirely on coarse pointers. The tile
    // carries no actions; the peek drawer's bar is plain layout with no
    // opacity gate, so every pointer sees the same controls.
    assert.doesNotMatch(taskDrawerStyles, /backlog-task-actions/);
    assert.match(taskDrawerStyles, /\.task-peek-actions\s*\{/);
    assert.doesNotMatch(taskDrawerStyles, /\.task-peek-actions\s*\{[^}]*opacity:\s*0/);
  });

  it("offers the same exact routine states that records display", () => {
    assert.match(routineChrome, /ROUTINE_STATE_ORDER\.map\(\(state\) =>/);
    assert.doesNotMatch(routineChrome, /value: "enabled"|value: "disabled"/);
  });

  it("gives the routine board one view and one sort grammar", () => {
    // The card grid is gone: the routine board is the list, so there is no
    // view toggle, no stored view preference, and no state sort option that
    // no column header could show.
    assert.doesNotMatch(routinesPage, /RoutineViewToggle|parseRoutineView|RoutineCard/);
    assert.doesNotMatch(routineChrome, /RoutineViewToggle|ROUTINE_VIEW_STORAGE_KEY/);
    assert.doesNotMatch(routinesPage, /key: "state"/);
    // Sorting has to stay reachable exactly where the column headers stop
    // being rendered — the same 820 tier the backlog list restacks at.
    assert.match(listSortStyles, /@media \(max-width: 820px\) \{[\s\S]{0,240}\.routine-page \.list-sort-menu \{ display: flex; \}/);
  });

  it("shows pending feedback and blocks duplicate starts", () => {
    for (const page of [backlogPage, routinesPage]) {
      assert.match(page, /startTaskMutation\.isPending/);
      assert.match(page, /startTaskMutation\.variables\?\.taskId/);
      assert.match(page, /if \(startInFlight\.current\) return/);
    }
    assert.match(backlogRecords, /loading=\{starting\}/);
    assert.match(routineRecords, /loading=\{starting\}/);
  });

  it("uses the compact reference as drawer identity on both boards", () => {
    assert.match(backlogPage, /taskRef\(form\.id\)/);
    assert.match(routinesPage, /taskRef\(form\.id\)/);
    assert.match(taskDrawer, /subtitleMono=\{Boolean\(form\.id\)\}/);
  });
});
