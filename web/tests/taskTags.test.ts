import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterTasks, type BacklogFilters } from "../src/lib/backlog.js";
import { filterRoutineTasks, type RoutineFilters } from "../src/lib/routine.js";
import { MAX_TAGS, TAG_TONES, addTags, collectTags, matchesTagFilter, normalizeTag, removeTag, tagTone, tagsEqual } from "../src/lib/taskTags.js";
import type { RelayTask } from "../src/types.js";

function task(id: string, tags: string[] | undefined, extra: Partial<RelayTask> = {}): RelayTask {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    priority: "normal",
    status: "backlog",
    isRoutine: false,
    linkedSessionIds: [],
    activity: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    events: [],
    ...(tags ? { tags } : {}),
    ...extra,
  } as RelayTask;
}

const backlogFilters: BacklogFilters = {
  query: "", status: "all", priority: "all", tag: "all", agent: "all", team: "all",
  assignment: "all", assignee: "", due: "all", source: "all",
};

const routineFilters: RoutineFilters = { trigger: "all", tag: "all", query: "", agent: "all", assignee: "", state: "all" };

describe("task tags", () => {
  it("normalizes a tag the way the backend stores it", () => {
    assert.equal(normalizeTag("  Front   end "), "Front end");
    assert.equal(normalizeTag(""), null);
    assert.equal(normalizeTag("a,b"), null);
    assert.equal(normalizeTag("x".repeat(33)), null);
  });

  it("adds comma-separated tags once each, case-insensitively, up to the cap", () => {
    assert.deepEqual(addTags(["Bug"], "bug, ui ,, infra"), ["Bug", "ui", "infra"]);
    const many = Array.from({ length: MAX_TAGS }, (_, index) => `t${index}`);
    assert.deepEqual(addTags(many, "extra"), many);
  });

  it("removes a tag regardless of case and compares lists in order", () => {
    assert.deepEqual(removeTag(["Bug", "ui"], "BUG"), ["ui"]);
    assert.equal(tagsEqual(["a", "b"], ["a", "b"]), true);
    assert.equal(tagsEqual(["a", "b"], ["b", "a"]), false);
    assert.equal(tagsEqual(undefined, []), true);
  });

  it("draws one tag in one tone whatever its case, always within the palette", () => {
    assert.equal(tagTone("Bug"), tagTone("bug"));
    const tones = ["bug", "api", "infra", "security", "reports", "ci", "docs", "billing", "design", "growth"].map(tagTone);
    assert.ok(tones.every((tone) => Number.isInteger(tone) && tone >= 1 && tone <= TAG_TONES));
    // A hash that collapsed everything onto one colour would defeat the dot.
    assert.ok(new Set(tones).size >= 5);
  });

  it("collects each tag in use once, alphabetically, keeping the first spelling", () => {
    assert.deepEqual(collectTags([task("1", ["ui", "Bug"]), task("2", ["bug", "api"]), task("3", undefined)]), ["api", "Bug", "ui"]);
  });

  it("matches the tag filter case-insensitively and passes everything on all", () => {
    assert.equal(matchesTagFilter(task("1", ["Bug"]), "bug"), true);
    assert.equal(matchesTagFilter(task("1", undefined), "bug"), false);
    assert.equal(matchesTagFilter(task("1", undefined), "all"), true);
  });

  it("filters the backlog by tag and finds tags through the search box", () => {
    const tasks = [task("1", ["ui"]), task("2", ["api"]), task("3", undefined)];
    assert.deepEqual(filterTasks(tasks, { ...backlogFilters, tag: "UI" }).map((item) => item.id), ["1"]);
    assert.deepEqual(filterTasks(tasks, { ...backlogFilters, query: "api" }).map((item) => item.id), ["2"]);
  });

  it("filters automations by tag", () => {
    const routines = [
      task("r1", ["reports"], { isRoutine: true, routineState: "paused" }),
      task("r2", ["ops"], { isRoutine: true, routineState: "paused" }),
    ];
    assert.deepEqual(filterRoutineTasks(routines, { ...routineFilters, tag: "ops" }).map((item) => item.id), ["r2"]);
  });
});
