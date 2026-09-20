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
    // The backlog list owns the row action cluster; the split of backlog.css
    // put it in its own sheet.
    const listStyles = await readFile(resolve("web/src/styles/backlog-list.css"), "utf8");
    const usages = source.match(/<RoutineStartButton\b/g) ?? [];

    assert.equal(usages.length, 1);
    assert.match(source, /variant="icon"/);
    assert.match(source, /size="icon-dense"/);
    assert.match(source, /tinted/);
    assert.match(source, /className="backlog-action-icon"/);
    // What this guards is that routine start is never the FILLED primary —
    // `variant="default"` is the only thing that fills a button, so that is
    // what gets asserted. It used to be asserted through the absence of the
    // `backlog-action-primary` class, on the reading that the class meant
    // "filled". It no longer does: the list's primary is an --action glyph on
    // a transparent plate (backlog-list.css), and the routine start button
    // now carries the class precisely so it picks that up and matches the
    // backlog row beside it. The class marks WHICH action is primary; the
    // variant decides how loudly it is drawn.
    assert.doesNotMatch(source, /<RoutineStartButton[\s\S]*?variant="default"/);
    assert.match(source, /className="backlog-action-primary backlog-action-icon"/);
    assert.match(listStyles, /\.backlog-row-actions \.backlog-action-primary \{[\s\S]*?color: var\(--action\)/);
    assert.match(listStyles, /\.backlog-row-actions button:not\(\[data-variant="icon"\]\)/);
  });
});
