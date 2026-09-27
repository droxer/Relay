import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("issue ids", () => {
  it("shows the stored id on issue, project task, routine, and record surfaces", async () => {
    const [routineRecords, bandFacts, issuesTable, backlogRecords] = await Promise.all([
      readFile(resolve("web/src/components/task-board/RoutineRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-record/recordBandFacts.tsx"), "utf8"),
      readFile(resolve("web/src/components/issues/IssuesTable.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-board/BacklogRecords.tsx"), "utf8"),
    ]);
    assert.match(routineRecords, /taskRef\(/);
    assert.match(routineRecords, /backlog\.col_ref/);
    assert.match(issuesTable, /taskRef\(task\.id\)/);
    assert.match(backlogRecords, /taskRef\(task\.id\)/);
    assert.match(bandFacts, /value: taskRef\(task\.id\)/);
    assert.match(bandFacts, /t\("backlog\.col_ref"\)/);
  });
});
