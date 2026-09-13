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
    assert.match(routinesPage, /useState<RoutineView>\("card"\)/);
    assert.match(routinesPage, /useEffect\(\(\) => \{\s*setView\(parseRoutineView\(null\)\)/);
  });

  it("limits backlog selection to records rendered on current lane pages", () => {
    assert.match(backlogPage, /const visibleTasks = TASK_FLOW_STAGES\.flatMap\(\(status\) => pagedLanes\[status\]\.items\)/);
    assert.doesNotMatch(backlogPage, /const visibleTasks = view === "list"[\s\S]{0,120}: filteredTasks/);
  });

  it("keeps card actions available on coarse or hoverless pointers", () => {
    assert.match(taskDrawerStyles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.backlog-task-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  });

  it("offers the same exact routine states that records display", () => {
    assert.match(routineChrome, /ROUTINE_STATE_ORDER\.map\(\(state\) =>/);
    assert.doesNotMatch(routineChrome, /value: "enabled"|value: "disabled"/);
  });

  it("only offers state sorting where it changes a flat card collection", () => {
    assert.match(routinesPage, /data-view=\{view\}/);
    assert.match(routinesPage, /view === "card"[\s\S]{0,240}key: "state"/);
    assert.match(routinesPage, /next === "list" && sort\?\.key === "state"/);
    assert.match(listSortStyles, /\.routine-page\[data-view="card"\] \.list-sort-menu\s*\{\s*display:\s*flex;/);
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
