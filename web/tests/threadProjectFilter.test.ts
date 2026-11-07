import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyThreadProjectFilter,
  resolveThreadProjectFilter,
  THREAD_PROJECT_FILTER_ALL,
  THREAD_PROJECT_FILTER_NONE,
  threadProjectFilterFor,
  threadProjectOptions,
} from "../src/lib/threadProjectFilter.js";

type Item = { session: { id: string; projectId?: string } };

function item(id: string, projectId?: string): Item {
  return { session: { id, projectId } };
}

const ids = (items: readonly Item[]) => items.map((entry) => entry.session.id);

describe("threadProjectOptions", () => {
  it("lists live projects by name and drops archived projects with no threads", () => {
    const options = threadProjectOptions(
      [
        { id: "p-b", name: "Beta" },
        { id: "p-old", name: "Old", archivedAt: "2026-01-01T00:00:00Z" },
        { id: "p-a", name: "Alpha" },
      ],
      [item("t1", "p-a")],
    );
    assert.deepEqual(options.map((option) => option.projectId), ["p-a", "p-b"]);
    assert.equal(options[0].value, threadProjectFilterFor("p-a"));
  });

  it("keeps an archived project that still holds a thread, after the live ones", () => {
    const options = threadProjectOptions(
      [
        { id: "p-old", name: "Aardvark", archivedAt: "2026-01-01T00:00:00Z" },
        { id: "p-a", name: "Zulu" },
      ],
      [item("t1", "p-old")],
    );
    assert.deepEqual(options.map((option) => [option.projectId, option.archived]), [["p-a", false], ["p-old", true]]);
  });
});

describe("resolveThreadProjectFilter", () => {
  const options = threadProjectOptions([{ id: "p-a", name: "Alpha" }], []);

  it("keeps the fixed choices and a project that is still offered", () => {
    assert.equal(resolveThreadProjectFilter(THREAD_PROJECT_FILTER_ALL, options), "all");
    assert.equal(resolveThreadProjectFilter(THREAD_PROJECT_FILTER_NONE, options), "none");
    assert.equal(resolveThreadProjectFilter(threadProjectFilterFor("p-a"), options), "project:p-a");
  });

  it("falls back to every thread when the chosen project is gone", () => {
    assert.equal(resolveThreadProjectFilter(threadProjectFilterFor("p-gone"), options), "all");
  });
});

describe("applyThreadProjectFilter", () => {
  // The rail leaves p-a's room thread (t-room) to the Projects directory but
  // shows its task thread (t-task).
  const rail = [item("t-plain"), item("t-task", "p-a"), item("t-other", "p-b")];
  const matched = [...rail, item("t-room", "p-a")];

  it("returns the ordinary rail for all", () => {
    assert.deepEqual(ids(applyThreadProjectFilter("all", rail, matched)), ["t-plain", "t-task", "t-other"]);
  });

  it("keeps only threads outside every project for none", () => {
    assert.deepEqual(ids(applyThreadProjectFilter("none", rail, matched)), ["t-plain"]);
  });

  it("shows every thread of the chosen project, room threads included", () => {
    assert.deepEqual(ids(applyThreadProjectFilter(threadProjectFilterFor("p-a"), rail, matched)), ["t-task", "t-room"]);
  });

  it("never treats a project id as a fixed choice", () => {
    const tricky = [item("t1", "all"), item("t2")];
    assert.deepEqual(ids(applyThreadProjectFilter(threadProjectFilterFor("all"), tricky, tricky)), ["t1"]);
  });
});
