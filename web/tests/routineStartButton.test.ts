import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("routine start button", () => {
  it("uses the shared compact icon treatment in both routine views", async () => {
    // The card and row renderers moved to task-board/RoutineRecords.tsx when
    // RoutinesPage.tsx was split, mirroring the BacklogPage split; the page
    // still owns the handler they call.
    const source = await readFile(
      resolve("web/src/components/task-board/RoutineRecords.tsx"),
      "utf8",
    );
    // The board and the list own their own action clusters, and the split of
    // backlog.css put them in different sheets — both still have to agree.
    const [boardStyles, listStyles] = await Promise.all([
      readFile(resolve("web/src/styles/task-status.css"), "utf8"),
      readFile(resolve("web/src/styles/backlog-list.css"), "utf8"),
    ]);
    const usages = source.match(/<RoutineStartButton\b/g) ?? [];

    assert.equal(usages.length, 2);
    assert.match(source, /variant="icon"/);
    assert.match(source, /size="icon-dense"/);
    assert.match(source, /tinted/);
    assert.match(source, /className="backlog-action-icon"/);
    assert.doesNotMatch(source, /className="backlog-action-primary backlog-action-icon"/);
    assert.match(boardStyles, /\.backlog-task-actions button:not\(\[data-variant="icon"\]\)/);
    assert.match(listStyles, /\.backlog-row-actions button:not\(\[data-variant="icon"\]\)/);
  });
});
