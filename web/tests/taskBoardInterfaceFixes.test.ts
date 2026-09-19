import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(`web/src/${path}`, "utf8");
}

const backlogPage = source("components/BacklogPage.tsx");
const routinesPage = source("components/RoutinesPage.tsx");
const backlogChrome = source("components/task-board/BacklogChrome.tsx");
const routineChrome = source("components/task-board/RoutineChrome.tsx");
const backlogRecords = source("components/task-board/BacklogRecords.tsx");
const routineRecords = source("components/task-board/RoutineRecords.tsx");
/* The fields moved to TaskBoardForm when the routine board grew a detail
   pane: the drawer is chrome now, the form is what both surfaces mount. */
const taskForm = source("components/task-board/TaskBoardForm.tsx");

describe("task board interface review fixes", () => {
  it("opts the task form's free-text fields out of autofill", () => {
    assert.match(taskForm, /name=\{`\$\{fieldPrefix\}-title`\}[\s\S]{0,200}?autoComplete="off"/);
    assert.match(taskForm, /name=\{`\$\{fieldPrefix\}-description`\}[\s\S]{0,200}?autoComplete="off"/);
  });

  it("moves focus to the title field when submit validation fails", () => {
    assert.match(taskForm, /setTitleError\([\s\S]{0,480}?\.focus\(\)/);
  });

  it("names the submit button after the action it performs", () => {
    assert.doesNotMatch(taskForm, /t\("dialog\.confirm"\)/);
    assert.match(taskForm, /"backlog\.save_task"/);
    assert.match(taskForm, /"backlog\.create_task"/);
    assert.match(taskForm, /"routine\.save"/);
    assert.match(taskForm, /"routine\.create"/);
  });

  it("exposes the action-group labels through a group role", () => {
    for (const src of [backlogRecords, routineRecords]) {
      assert.doesNotMatch(src, /<div className="backlog-action-group" aria-label/);
      assert.match(src, /<div className="backlog-action-group" role="group" aria-label/);
    }
  });

  it("exposes the stats-bar label through a group role", () => {
    // The backlog is the only board with a stat bar: the routine board's rail
    // already counts every schedule state, so a bar there only restated it.
    assert.doesNotMatch(backlogChrome, /<p className="backlog-stats" aria-label/);
    assert.match(backlogChrome, /<p className="backlog-stats" role="group" aria-label/);
    assert.doesNotMatch(routineChrome, /backlog-stats/);
  });

  it("stores backlog and routine filters in the URL", () => {
    assert.match(backlogPage, /useUrlFilters\(initialFilters, BACKLOG_FILTER_SPEC\)/);
    assert.match(routinesPage, /useUrlFilters\(initialRoutineFilters, ROUTINE_FILTER_SPEC\)/);
    assert.doesNotMatch(backlogPage, /useState\(initialFilters\)/);
    assert.doesNotMatch(routinesPage, /useState\(initialRoutineFilters\)/);
  });
});
