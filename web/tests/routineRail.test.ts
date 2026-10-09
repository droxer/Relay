import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve("web", path), "utf8");

/**
 * The routine board's schedule states.
 *
 * Schedule health used to do three jobs on this page at once — a select in
 * the filter bar, the bands the list grouped on, and a sort column — so the
 * same dimension was answered in three different grammars. The state nav is
 * now the one control for it. It was a 240px rail beside the board; it is
 * now view tabs on the page header (SectionNav `tabs`), so the table keeps
 * the full width.
 */
describe("routine section rail", () => {
  it("is header view tabs in the shared SectionNav grammar, not a rail", async () => {
    const source = await read("src/components/RoutinesPage.tsx");
    const chrome = await read("src/components/task-board/RoutineChrome.tsx");

    assert.match(source, /className="routine-page"/);
    assert.doesNotMatch(source, /sec-rail|sec-shell/);
    assert.match(source, /views=\{\(\s*<RoutineStateNav\b/);
    assert.match(chrome, /variant="tabs"/);
  });

  it("drives the rail off the URL's own state filter", async () => {
    const page = await read("src/components/RoutinesPage.tsx");
    const chrome = await read("src/components/task-board/RoutineChrome.tsx");

    // No second source of truth: the rail writes `filters.state`, the param
    // `?state=` already registered in LIST_FILTER_PARAMS.routines.
    assert.match(page, /value=\{filters\.state\}/);
    assert.match(page, /setFilters\(\{ \.\.\.filters, state \}\)/);
    assert.doesNotMatch(page, /useState<RoutineState/);
    // …and the select that used to own it is gone from the filter bar.
    assert.doesNotMatch(chrome, /routine-state-filter/);
    assert.doesNotMatch(chrome, /filters\.state !== "all"/);
  });

  it("names every section, including the ones holding nothing", async () => {
    const chrome = await read("src/components/task-board/RoutineChrome.tsx");

    assert.match(chrome, /ROUTINE_STATE_ORDER\.map/);
    // An "all" section, and counts that survive a zero — a rail that drops
    // its empty sections reshuffles under the pointer as you type.
    assert.match(chrome, /id: "all"/);
    assert.match(chrome, /counts\[state\] \?\? 0/);
    assert.doesNotMatch(chrome, /counts\[state\] > 0/);
  });

  it("counts against every filter except the one the rail owns", async () => {
    const page = await read("src/components/RoutinesPage.tsx");

    // Otherwise "Overdue 3" would be computed from a list already narrowed to
    // overdue, and every other section would read 0.
    assert.match(page, /filterRoutineTasks\(tasks, \{ \.\.\.filters, state: "all" \}\)/);
    assert.match(page, /routineStateCounts\(/);
  });

  it("leaves the board flat — the rail is the grouping now", async () => {
    const page = await read("src/components/RoutinesPage.tsx");

    assert.doesNotMatch(page, /ListGroup/);
    assert.doesNotMatch(page, /routinesByState/);
    assert.doesNotMatch(page, /useLanePagination/);
    // One cursor for one collection.
    assert.match(page, /const \{ page, setPage \} = usePagination\(\)/);
  });

  it("never repeats the selected section on the records under it", async () => {
    const page = await read("src/components/RoutinesPage.tsx");
    const records = await read("src/components/task-board/RoutineRecords.tsx");

    // Same rule the rows follow under a band: the thing above has said it, so
    // the record does not say it again. A row states schedule health as the
    // dot in its state cell — a mark, not a second copy of the section word.
    assert.doesNotMatch(page, /showState/);
    assert.doesNotMatch(records, /<RoutineStateBadge state=\{state\} \/>/);
    assert.match(records, /<StateMark shape=\{ROUTINE_STATE_SHAPE\[state\]\} \/>/);
  });

  it("keeps the rail out of the shell's own grid", async () => {
    // The second menu lives INSIDE the routine page, so the shell still gives
    // /routines the same two tracks every other work page gets.
    const routes = await read("src/styles/routes.css");
    assert.match(routes, /\.messenger-shell\[data-route="routine"\],\n/);
  });
});
