import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("routine start button", () => {
  it("uses the shared compact icon treatment on the routine row", async () => {
    // The row renderer moved to task-board/RoutineRecords.tsx when
    // RoutinesPage.tsx was split, mirroring the BacklogPage split; the page
    // still owns the handler it calls.
    const source = await readFile(
      resolve("web/src/components/task-board/RoutineRecords.tsx"),
      "utf8",
    );
    const usages = source.match(/<RoutineStartButton\b/g) ?? [];

    assert.equal(usages.length, 1);
    assert.match(source, /variant="icon"/);
    assert.match(source, /size="icon-dense"/);
    assert.match(source, /tinted/);
    assert.match(source, /className="backlog-action-primary backlog-action-icon"/);
    assert.doesNotMatch(source, /<RoutineStartButton[\s\S]*?variant="default"/);
  });
});
