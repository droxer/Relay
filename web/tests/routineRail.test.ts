import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve("web", path), "utf8");

/**
 * The routine board's rail.
 *
 * It listed schedule states as sections once — because schedule health used
 * to be answered three ways on this page at once, and a rail of states
 * collapsed two of them. But a section is the wrong noun here: a routine IS
 * the thing being read. So the rail lists the routines themselves, each
 * carrying its state as a mark, and selecting one opens it in the pane
 * beside the rail.
 */
describe("routine roster rail", () => {
  it("is a roster of records, not a nav of sections", async () => {
    const page = await read("src/components/RoutinesPage.tsx");
    const rail = await read("src/components/task-board/RoutineRosterRail.tsx");

    assert.match(page, /<RoutineRosterRail\b/);
    assert.doesNotMatch(page, /RoutineStateNav|sec-shell|sec-rail|sec-main/);
    // One row per routine, in the row contract every other rail uses.
    assert.match(rail, /className="routine-roster-row rail-row"/);
    assert.match(rail, /routines\.map\(\(routine\) =>/);
    // …and the nav it replaced is gone from the board's chrome entirely.
    const chrome = await read("src/components/task-board/RoutineChrome.tsx");
    assert.doesNotMatch(chrome, /SectionNav|RoutineStateNav/);
  });

  it("states each routine's schedule health on its own row", async () => {
    const rail = await read("src/components/task-board/RoutineRosterRail.tsx");

    // A mark plus a word — the shape alone reaches nobody using a reader.
    assert.match(rail, /ROUTINE_STATE_SHAPE\[state\]/);
    assert.match(rail, /className="sr-only">\{t\(`routine\.states\.\$\{state\}`\)\}/);
    // Derived once for the whole board and handed down, never per row.
    assert.match(rail, /stateOf: \(routine: RelayTaskListItem\) => RoutineState/);
  });

  it("drives the rail off the URL's own filters", async () => {
    const page = await read("src/components/RoutinesPage.tsx");
    const chrome = await read("src/components/task-board/RoutineChrome.tsx");

    // No second source of truth: the rail writes `filters.state` and
    // `filters.query`, the `?state=`/`?q=` params already registered in
    // LIST_FILTER_PARAMS.routines.
    assert.match(page, /state=\{filters\.state\}/);
    assert.match(page, /query=\{filters\.query\}/);
    assert.match(page, /setFilters\(\{ \.\.\.filters, state \}\)/);
    assert.doesNotMatch(page, /useState<RoutineState/);
    /* One search box and one state control VISIBLE at a time. The table's bar
       carries a second pair for the widths where the rail is not rendered —
       the same trade the sort menu makes against the column headers — and
       both write the same `filters`, so they cannot disagree. */
    assert.match(chrome, /routine-state-filter-narrow/);
    assert.match(chrome, /className="routine-narrow-only"/);
    const styles = await read("src/styles/backlog-list.css");
    assert.match(styles, /\.routine-narrow-only,[\s\S]{0,220}display: none;/);
    assert.match(styles, /@media \(max-width: 820px\)[\s\S]{0,900}\.routine-narrow-only \{ display: inline-flex; \}/);
  });

  it("offers every state to narrow by, including the empty ones", async () => {
    const rail = await read("src/components/task-board/RoutineRosterRail.tsx");

    assert.match(rail, /ROUTINE_STATE_ORDER\.map/);
    assert.match(rail, /value: "all" as const/);
  });

  it("leaves the table flat — the rail is the index now", async () => {
    const page = await read("src/components/RoutinesPage.tsx");

    assert.doesNotMatch(page, /ListGroup/);
    assert.doesNotMatch(page, /routinesByState/);
    assert.doesNotMatch(page, /useLanePagination/);
    // One cursor for one collection.
    assert.match(page, /const \{ page, setPage \} = usePagination\(\)/);
  });

  it("selects into the path, so a routine is a link", async () => {
    const page = await read("src/components/RoutinesPage.tsx");
    const route = await read("src/lib/appRoute.ts");

    assert.match(page, /onSelect=\{openRoutine\}/);
    assert.match(page, /onSelectRoutine\(NEW_ROUTINE_ID\)/);
    assert.match(route, /head === "routines" && second && rest\.length === 0/);
    assert.match(route, /route === "routine" && routineId/);
    // The rail stays beside the record, so its filters survive the record's
    // own path — otherwise selecting would clear the search that found it.
    assert.match(route, /head === "routines" && entityId && rest\.length === 0/);
  });

  it("keeps the rail out of the shell's own grid", async () => {
    // The second menu lives INSIDE the routine page, so the shell still gives
    // /routines the same two tracks every other work page gets.
    const routes = await read("src/styles/routes.css");
    assert.match(routes, /\.messenger-shell\[data-route="routine"\],\n/);
  });
});
