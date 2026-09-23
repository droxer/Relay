import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("task references", () => {
  it("keeps the short REF identity on every row and in the shared record band", async () => {
    const [routineRecords, bandFacts] = await Promise.all([
      readFile(resolve("web/src/components/task-board/RoutineRecords.tsx"), "utf8"),
      readFile(resolve("web/src/components/task-record/recordBandFacts.tsx"), "utf8"),
    ]);

    // The routine list's row states its ref in the ref COLUMN. The backlog
    // list runs its compact column set, which has no ref column; there the
    // ref identity lives only in the shared record band below.
    assert.match(routineRecords, /taskRef\(/);
    assert.match(routineRecords, /backlog\.col_ref/);
    // The card is a tile and states no address of its own: the ref rides in
    // the shared record band, so the record drawer prints the same identity
    // the row did.
    assert.match(bandFacts, /value: taskRef\(task\.id\)/);
    assert.match(bandFacts, /t\("backlog\.col_ref"\)/);
  });
});
