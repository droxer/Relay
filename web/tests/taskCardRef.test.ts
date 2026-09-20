import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("task references", () => {
  it("keeps the short REF identity on every row and in the shared record band", async () => {
    const [backlogRecords, routineRecords, bandFacts] = await Promise.all([
      readFile(resolve("web/src/components/task-board/BacklogRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-board/RoutineRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-record/recordBandFacts.tsx"), "utf8"),
    ]);

    // Every row states its ref in the ref COLUMN.
    for (const records of [backlogRecords, routineRecords]) {
      assert.match(records, /className="backlog-row-ref code">\{taskRef\(task\.id\)\}/);
    }
    // The card is a tile and states no address of its own: the ref rides in
    // the shared record band, so the record drawer prints the same identity
    // the row did.
    assert.match(bandFacts, /value: taskRef\(task\.id\)/);
    assert.match(bandFacts, /t\("backlog\.col_ref"\)/);
  });
});
