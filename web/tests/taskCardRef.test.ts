import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("issue refs", () => {
  it("shows a clickable sequence ref on issue, project task, and routine lists", async () => {
    const [routineRecords, issuesTable, backlogRecords] = await Promise.all([
      readFile(resolve("web/src/components/task-board/RoutineRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/issues/IssuesTable.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-board/BacklogRecords.tsx"), "utf8"),
    ]);
    assert.match(routineRecords, /<TaskRefLink task=\{row\.original\} href=\{hrefForRoutineRecord/);
    assert.match(routineRecords, /backlog\.col_ref/);
    assert.match(issuesTable, /<TaskRefLink task=\{task\} href=\{hrefForTaskRecord\(task\.id\)\}/);
    assert.match(backlogRecords, /<TaskRefLink task=\{task\} href=\{hrefForTaskRecord\(task\.id\)\} onOpen=\{onOpen\}/);
    assert.match(backlogRecords, /<TaskRefLink task=\{row\.original\}/);
    for (const source of [routineRecords, issuesTable, backlogRecords]) {
      assert.doesNotMatch(source, /taskRef\([a-z.]*\.id\)/);
    }
  });

  it("names the record by its ref in the record band", async () => {
    const bandFacts = await readFile(resolve("web/src/components/task-record/recordBandFacts.tsx"), "utf8");
    assert.match(bandFacts, /value: taskRef\(task\)/);
    assert.match(bandFacts, /t\("backlog\.col_ref"\)/);
  });
});
