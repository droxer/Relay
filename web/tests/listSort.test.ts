import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySort,
  byDate,
  byNumber,
  byRank,
  byText,
  nextSortState,
  parseSortParam,
  serializeSortParam,
  sortIndicator,
  type SortColumn,
  type SortState,
} from "../src/lib/listSort.js";

interface Row {
  id: string;
  name: string;
  score: number;
  due?: string;
  priority: "high" | "normal" | "low";
}

const COLUMNS: readonly SortColumn<Row, "name" | "score" | "due" | "priority">[] = [
  { key: "name", compare: byText((row) => row.name) },
  { key: "score", compare: byNumber((row) => row.score), defaultDirection: "desc" },
  { key: "due", compare: byDate((row) => row.due), isMissing: (row) => !row.due },
  { key: "priority", compare: byRank((row) => row.priority, ["high", "normal", "low"]) },
];

const ROWS: Row[] = [
  { id: "a", name: "beta", score: 2, due: "2026-03-01", priority: "low" },
  { id: "b", name: "Alpha", score: 9, priority: "high" },
  { id: "c", name: "gamma", score: 2, due: "2026-01-01", priority: "normal" },
];

function ids(rows: readonly Row[]): string[] {
  return rows.map((row) => row.id);
}

describe("applySort", () => {
  it("returns the input order untouched when no sort is active", () => {
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, null)), ["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [...ROWS];
    applySort(input, COLUMNS, { key: "name", direction: "asc" });
    assert.deepEqual(ids(input), ["a", "b", "c"]);
  });

  it("sorts text case-insensitively", () => {
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "name", direction: "asc" })), ["b", "a", "c"]);
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "name", direction: "desc" })), ["c", "a", "b"]);
  });

  it("sorts numbers in both directions", () => {
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "score", direction: "desc" })), ["b", "a", "c"]);
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "score", direction: "asc" })), ["a", "c", "b"]);
  });

  it("is stable — equal rows keep their incoming order in both directions", () => {
    // a and c both score 2; they must stay a-before-c whichever way we sort.
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "score", direction: "asc" })).slice(0, 2), ["a", "c"]);
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "score", direction: "desc" })).slice(1), ["a", "c"]);
  });

  it("keeps missing values last regardless of direction", () => {
    // b has no due date, so it sits at the bottom ascending AND descending —
    // flipping the direction must not float "nothing scheduled" to the top.
    assert.equal(ids(applySort(ROWS, COLUMNS, { key: "due", direction: "asc" })).at(-1), "b");
    assert.equal(ids(applySort(ROWS, COLUMNS, { key: "due", direction: "desc" })).at(-1), "b");
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "due", direction: "asc" })), ["c", "a", "b"]);
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "due", direction: "desc" })), ["a", "c", "b"]);
  });

  it("sorts an enumerated column by its declared rank, not alphabetically", () => {
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, { key: "priority", direction: "asc" })), ["b", "c", "a"]);
  });

  it("ignores a sort key that no column declares", () => {
    const state = { key: "nope", direction: "asc" } as unknown as SortState<"name">;
    assert.deepEqual(ids(applySort(ROWS, COLUMNS, state)), ["a", "b", "c"]);
  });
});

describe("nextSortState", () => {
  it("opens a column on its default direction", () => {
    assert.deepEqual(nextSortState(null, "name", COLUMNS), { key: "name", direction: "asc" });
    assert.deepEqual(nextSortState(null, "score", COLUMNS), { key: "score", direction: "desc" });
  });

  it("reverses the direction when the active column is clicked again", () => {
    assert.deepEqual(
      nextSortState({ key: "name", direction: "asc" }, "name", COLUMNS),
      { key: "name", direction: "desc" },
    );
  });

  it("clears the sort on the third click, restoring the surface's own order", () => {
    assert.equal(nextSortState({ key: "name", direction: "desc" }, "name", COLUMNS), null);
  });

  it("switching columns opens the new column fresh rather than inheriting a direction", () => {
    assert.deepEqual(
      nextSortState({ key: "name", direction: "desc" }, "score", COLUMNS),
      { key: "score", direction: "desc" },
    );
  });
});

describe("sort url param", () => {
  it("round-trips both directions", () => {
    const keys = ["name", "score"] as const;
    assert.deepEqual(parseSortParam("name", keys), { key: "name", direction: "asc" });
    assert.deepEqual(parseSortParam("-score", keys), { key: "score", direction: "desc" });
    assert.equal(serializeSortParam({ key: "name", direction: "asc" }), "name");
    assert.equal(serializeSortParam({ key: "score", direction: "desc" }), "-score");
  });

  it("drops the param entirely when nothing is sorted", () => {
    assert.equal(serializeSortParam(null), null);
    assert.equal(parseSortParam(null, ["name"] as const), null);
  });

  it("rejects a key the surface does not offer, so a stale link cannot wedge the list", () => {
    assert.equal(parseSortParam("-bogus", ["name"] as const), null);
    assert.equal(parseSortParam("", ["name"] as const), null);
    assert.equal(parseSortParam("-", ["name"] as const), null);
  });
});

describe("sortIndicator", () => {
  it("reports aria-sort per column so only the active one is announced", () => {
    const state: SortState<"name" | "score"> = { key: "name", direction: "asc" };
    assert.deepEqual(sortIndicator(state, "name"), { active: true, direction: "asc", ariaSort: "ascending" });
    assert.deepEqual(sortIndicator(state, "score"), { active: false, direction: null, ariaSort: "none" });
    assert.deepEqual(
      sortIndicator({ key: "score", direction: "desc" }, "score"),
      { active: true, direction: "desc", ariaSort: "descending" },
    );
    assert.deepEqual(sortIndicator(null, "name"), { active: false, direction: null, ariaSort: "none" });
  });
});

/* ── The surfaces' own column sets ──────────────────────────────────── */

import { backlogSortColumns, filterTasks, type BacklogFilters } from "../src/lib/backlog.js";
import { routineSortColumns } from "../src/lib/routine.js";
import type { RelayTask, RelayTaskListItem } from "../src/types.js";

const NO_FILTERS: BacklogFilters = {
  query: "", status: "all", priority: "all", agent: "all", team: "all", assignment: "all", assignee: "", due: "all", source: "all",
};

function backlogTask(input: Partial<RelayTask> & { id: string; title: string }): RelayTaskListItem {
  return {
    description: "",
    priority: "normal",
    status: "backlog",
    ownerEmployeeId: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...input,
  } as RelayTaskListItem;
}

describe("backlog columns", () => {
  const tasks = [
    backlogTask({ id: "t1", title: "Zebra", priority: "low", status: "done", dueDate: "2026-05-01" }),
    backlogTask({ id: "t2", title: "apple", priority: "high", status: "running" }),
    backlogTask({ id: "t3", title: "Mango", priority: "normal", status: "backlog", dueDate: "2026-02-01" }),
  ];
  const columns = backlogSortColumns(() => "");

  it("offers a column for every sortable header the list renders", () => {
    assert.deepEqual(
      columns.map((column) => column.key),
      ["title", "status", "priority", "assignee", "due"],
    );
  });

  it("orders status by the board lifecycle, not the alphabet", () => {
    // backlog → running → done; alphabetically it would be backlog, done, running.
    assert.deepEqual(
      applySort(tasks, columns, { key: "status", direction: "asc" }).map((task) => task.id),
      ["t3", "t2", "t1"],
    );
  });

  it("orders priority high → low", () => {
    assert.deepEqual(
      applySort(tasks, columns, { key: "priority", direction: "asc" }).map((task) => task.id),
      ["t2", "t3", "t1"],
    );
  });

  it("keeps undated tasks at the bottom in both directions", () => {
    assert.equal(applySort(tasks, columns, { key: "due", direction: "asc" }).at(-1)?.id, "t2");
    assert.equal(applySort(tasks, columns, { key: "due", direction: "desc" }).at(-1)?.id, "t2");
  });

  it("sorts assignee by the name the row prints, not the raw employee id", () => {
    // The row shows a resolved display name, so sorting by the underlying id
    // would order the list by something invisible.
    const named = backlogSortColumns((task) => (task.id === "t1" ? "Ada" : "Zoe"));
    assert.equal(applySort(tasks, named, { key: "assignee", direction: "asc" })[0].id, "t1");
  });

  it("leaves filterTasks' considered default order intact when unsorted", () => {
    const filtered = filterTasks(tasks, NO_FILTERS);
    assert.deepEqual(applySort(filtered, columns, null), filtered);
  });
});

describe("routine columns", () => {
  const routines = [
    backlogTask({ id: "r1", title: "Nightly", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-04-02" }),
    backlogTask({ id: "r2", title: "Weekly", isRoutine: true, routineEnabled: false }),
    backlogTask({ id: "r3", title: "Hourly", isRoutine: true, routineEnabled: true, routineNextRunDate: "2026-04-01" }),
  ];
  const columns = routineSortColumns(() => "");

  it("offers a column for every sortable header the list renders", () => {
    assert.deepEqual(
      columns.map((column) => column.key),
      ["title", "priority", "assignee", "nextRun"],
    );
  });

  it("keeps unscheduled routines at the bottom in both directions", () => {
    assert.equal(applySort(routines, columns, { key: "nextRun", direction: "asc" }).at(-1)?.id, "r2");
    assert.equal(applySort(routines, columns, { key: "nextRun", direction: "desc" }).at(-1)?.id, "r2");
  });

  it("offers no state column — the section rail owns schedule health", () => {
    // A state sort would be an order no control on the list could show: the
    // state cell is a dot with no header, and the sort menu mirrors headers.
    assert.equal(columns.map((column) => String(column.key)).includes("state"), false);
  });
});
