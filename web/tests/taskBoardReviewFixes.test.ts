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
const routineDetail = source("components/task-board/RoutineDetail.tsx");
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

  it("keeps card actions available on coarse or hoverless pointers", () => {
    assert.match(taskDrawerStyles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.backlog-task-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  });

  it("offers the same exact routine states that records display", () => {
    // The state control moved to the roster rail with the rest of the rail's
    // vocabulary; it still enumerates the derived states, never the raw
    // enabled/disabled flag the records stopped showing.
    const routineRail = source("components/task-board/RoutineRosterRail.tsx");
    assert.match(routineRail, /ROUTINE_STATE_ORDER\.map\(\(value\) =>/);
    assert.doesNotMatch(routineRail, /value: "enabled"|value: "disabled"/);
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

  it("uses the compact reference as record identity on both boards", () => {
    // The backlog names its record in the drawer's own subtitle; the routine
    // board prints the same ref as the first fact of its RecordBand.
    assert.match(backlogPage, /taskRef\(form\.id\)/);
    assert.match(taskDrawer, /subtitleMono=\{Boolean\(form\.id\)\}/);
    assert.match(routineDetail, /taskRef\(task\.id\)/);
    assert.match(routineDetail, /technical: true/);
  });
});
