import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySort } from "../src/lib/listSort.js";
import {
  buildUserSummaries,
  userSortColumns,
  nodeSortColumns,
  stableNodeOrder,
} from "../src/lib/adminHelpers.js";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../src/types.js";

function node(input: Partial<ControlPanelDaemonNodeRecord> & { id: string }): ControlPanelDaemonNodeRecord {
  return {
    status: "ready",
    // Fresh + connected, so visualStatus reports the record status rather than
    // collapsing every fixture to "stale".
    online: true,
    agents: {},
    workspacePath: "/w",
    queuedCommandCount: 0,
    updatedAt: "2026-01-01T00:00:00Z",
    lastSeenAt: new Date().toISOString(),
    ...input,
  } as ControlPanelDaemonNodeRecord;
}

function user(id: string, displayName: string): UserRecord {
  return { id, displayName } as UserRecord;
}

describe("node table columns", () => {
  const nodes = [
    node({ id: "n-c", displayName: "charlie", userId: "e2", status: "failed" }),
    node({ id: "n-a", displayName: "alpha", status: "ready" }),
    node({ id: "n-b", displayName: "bravo", userId: "e1", status: "running" }),
  ];
  const users = [user("e1", "Ada"), user("e2", "Zoe")];
  const columns = nodeSortColumns(new Map(users.map((e) => [e.id, e])));

  it("covers the node table's data columns and nothing else", () => {
    // No `status`: health renders as pills inside the node cell, and a sort
    // with no column header is a sort nobody can reach.
    assert.deepEqual(columns.map((column) => column.key), ["node", "user", "runtimes"]);
  });

  it("sorts by the label the row shows, falling back to the id when unnamed", () => {
    const unnamed = [node({ id: "zzz" }), node({ id: "n-a", displayName: "alpha" })];
    assert.deepEqual(
      applySort(unnamed, columns, { key: "node", direction: "asc" }).map((n) => n.id),
      ["n-a", "zzz"],
    );
  });

  it("keeps unassigned nodes last in both directions", () => {
    // An unassigned node has no owner to sort among the owners.
    assert.equal(applySort(nodes, columns, { key: "user", direction: "asc" }).at(-1)?.id, "n-a");
    assert.equal(applySort(nodes, columns, { key: "user", direction: "desc" }).at(-1)?.id, "n-a");
    assert.deepEqual(
      applySort(nodes, columns, { key: "user", direction: "asc" }).map((n) => n.id),
      ["n-b", "n-c", "n-a"],
    );
  });

  it("leaves stableNodeOrder in charge when nothing is sorted", () => {
    const ordered = stableNodeOrder(nodes);
    assert.deepEqual(applySort(ordered, columns, null), ordered);
  });
});

describe("user table columns", () => {
  const users = [user("e1", "Zoe"), user("e2", "Ada")];
  const nodes = [
    node({ id: "n1", userId: "e1", status: "running" }),
    node({ id: "n2", userId: "e1", status: "ready" }),
    node({ id: "n3", userId: "e2", status: "ready" }),
  ];
  const summaries = buildUserSummaries(users, nodes);
  const columns = userSortColumns();

  it("covers the user table's data columns and nothing else", () => {
    assert.deepEqual(
      columns.map((column) => column.key),
      ["user", "computers", "localLimit", "running", "ready"],
    );
  });

  it("sorts people by name and counts most-first", () => {
    assert.deepEqual(
      applySort(summaries, columns, { key: "user", direction: "asc" }).map((s) => s.id),
      ["e2", "e1"],
    );
    assert.deepEqual(
      applySort(summaries, columns, { key: "computers", direction: "desc" }).map((s) => s.id),
      ["e1", "e2"],
    );
  });

  it("opens every count column on descending — 'who has the most' is the question", () => {
    for (const key of ["computers", "localLimit", "running", "ready"]) {
      const column = columns.find((candidate) => candidate.key === key);
      assert.equal(column?.defaultDirection, "desc", key);
    }
    assert.equal(columns.find((column) => column.key === "user")?.defaultDirection, undefined);
  });
});
