import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_FILTER_QUERY,
  reconcileQuery,
  selectionsFromQuery,
  selectionsFromState,
  stateFromSelections,
  type SelectionField,
  type SelectionQuery,
} from "../src/lib/filterSelections.js";

const FIELDS: SelectionField[] = [
  { id: "priority", kind: "select" },
  { id: "due", kind: "select" },
  { id: "assignee", kind: "text" },
];

function rule(id: string, path: string, operator: string, value: unknown, negated?: boolean) {
  return { id, type: "rule" as const, path: [path], operator, value, ...(negated ? { negated } : {}) };
}
function query(...rules: ReturnType<typeof rule>[]): SelectionQuery {
  return { ...EMPTY_FILTER_QUERY, rules };
}

describe("selectionsFromQuery", () => {
  it("reads nothing selected from an empty query", () => {
    assert.deepEqual(selectionsFromQuery(EMPTY_FILTER_QUERY, FIELDS), { priority: "", due: "", assignee: "" });
  });

  it("reads a complete select rule as that field's value, and a text rule by contains", () => {
    const selections = selectionsFromQuery(query(rule("a", "priority", "is", "high"), rule("b", "assignee", "contains", "ana")), FIELDS);
    assert.deepEqual(selections, { priority: "high", due: "", assignee: "ana" });
  });

  it("ignores rules the flat store cannot hold: unfinished, negated, other operators, unknown fields", () => {
    const selections = selectionsFromQuery(query(
      rule("a", "priority", "", undefined),
      rule("b", "due", "is", "today", true),
      rule("c", "priority", "is_not", "low"),
      rule("d", "nope", "is", "x"),
      rule("e", "assignee", "contains", ""),
    ), FIELDS);
    assert.deepEqual(selections, { priority: "", due: "", assignee: "" });
  });
});

describe("reconcileQuery", () => {
  it("builds a rule per selected field", () => {
    const next = reconcileQuery(EMPTY_FILTER_QUERY, { priority: "high", due: "", assignee: "ana" }, FIELDS);
    assert.deepEqual(next.rules.map((r) => [r.path[0], r.operator, r.value]), [["priority", "is", "high"], ["assignee", "contains", "ana"]]);
  });

  it("keeps a rule the reader is still building, which the store cannot hold yet", () => {
    const draft = query(rule("pending", "due", "", undefined));
    const next = reconcileQuery(draft, { priority: "", due: "", assignee: "" }, FIELDS);
    assert.deepEqual(next.rules.map((r) => r.id), ["pending"]);
  });

  it("keeps a matching rule's identity, so its chip is not remounted", () => {
    const draft = query(rule("chip-1", "priority", "is", "high"));
    const next = reconcileQuery(draft, { priority: "high", due: "", assignee: "" }, FIELDS);
    assert.deepEqual(next.rules.map((r) => r.id), ["chip-1"]);
  });

  it("follows the store when it changes elsewhere (Clear, a pasted URL)", () => {
    const draft = query(rule("chip-1", "priority", "is", "high"), rule("chip-2", "due", "is", "today"));
    const next = reconcileQuery(draft, { priority: "low", due: "", assignee: "" }, FIELDS);
    assert.deepEqual(next.rules.map((r) => [r.path[0], r.value]), [["priority", "low"]]);
  });

  it("round-trips: the selections read back out of the reconciled query", () => {
    const selections = { priority: "urgent", due: "overdue", assignee: "" };
    assert.deepEqual(selectionsFromQuery(reconcileQuery(EMPTY_FILTER_QUERY, selections, FIELDS), FIELDS), selections);
  });
});

describe("page state ↔ selections", () => {
  const state = { priority: "all", due: "today", assignee: "" };
  const keys = ["priority", "due", "assignee"] as const;

  it("reads the state's 'all' (and an empty text filter) as not filtering", () => {
    assert.deepEqual(selectionsFromState(state, keys), { priority: "", due: "today", assignee: "" });
  });

  it("writes a cleared choice back as 'all' and a cleared text filter as ''", () => {
    assert.deepEqual(stateFromSelections({ priority: "", due: "overdue", assignee: "" }, keys, ["assignee"]), {
      priority: "all", due: "overdue", assignee: "",
    });
  });
});
