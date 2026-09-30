import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  batchOutcome,
  EMPTY_TASK_SELECTION,
  pruneSelection,
  selectedTasks,
  selectionCheckState,
  toggleAllSelected,
  toggleSelected,
} from "../src/lib/taskSelection.js";

describe("task selection", () => {
  it("toggles a record without mutating the previous selection", () => {
    const first = toggleSelected(EMPTY_TASK_SELECTION, "task_a");
    const second = toggleSelected(first, "task_b");
    const third = toggleSelected(second, "task_a");

    assert.deepEqual([...first], ["task_a"]);
    assert.deepEqual([...second], ["task_a", "task_b"]);
    assert.deepEqual([...third], ["task_b"]);
    assert.equal(EMPTY_TASK_SELECTION.size, 0);
  });

  it("drops records that are no longer on screen", () => {
    const selection = new Set(["task_a", "task_b", "task_c"]);
    assert.deepEqual([...pruneSelection(selection, ["task_b", "task_d"])], ["task_b"]);
  });

  it("keeps the same selection object when everything is still visible", () => {
    const selection = new Set(["task_a"]);
    assert.equal(pruneSelection(selection, ["task_a", "task_b"]), selection);
  });

  it("reports none, some, and all against the visible records", () => {
    const visible = ["task_a", "task_b"];
    assert.equal(selectionCheckState(EMPTY_TASK_SELECTION, visible), "none");
    assert.equal(selectionCheckState(new Set(["task_a"]), visible), "some");
    assert.equal(selectionCheckState(new Set(["task_a", "task_b"]), visible), "all");
    // A selection made of hidden records reads as none, not as some.
    assert.equal(selectionCheckState(new Set(["task_z"]), visible), "none");
    assert.equal(selectionCheckState(new Set(["task_a"]), []), "none");
  });

  it("selects every visible record, then clears on the second toggle", () => {
    const visible = ["task_a", "task_b"];
    const all = toggleAllSelected(EMPTY_TASK_SELECTION, visible);
    assert.deepEqual([...all], visible);
    assert.deepEqual([...toggleAllSelected(all, visible)], []);
    // A partial selection completes rather than clearing.
    assert.deepEqual([...toggleAllSelected(new Set(["task_a"]), visible)], visible);
  });

  it("returns the selected records in render order", () => {
    const tasks = [{ id: "task_a" }, { id: "task_b" }, { id: "task_c" }];
    assert.deepEqual(selectedTasks(tasks, new Set(["task_c", "task_a"])), [{ id: "task_a" }, { id: "task_c" }]);
  });

  it("splits a settled batch into what went and what refused", () => {
    const outcome = batchOutcome(["task_a", "task_b", "task_c"], [
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: new Error("active work") },
      { status: "fulfilled", value: undefined },
    ]);

    assert.deepEqual(outcome.succeeded, ["task_a", "task_c"]);
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0].id, "task_b");
  });
});

describe("batch delete surface", () => {
  it("confirms the batch and only unselects what actually deleted", async () => {
    for (const page of ["BacklogPage", "RoutinesPage"]) {
      const source = await readFile(resolve(`web/src/components/${page}.tsx`), "utf8");
      assert.match(source, /deleteTasksMutation\.mutateAsync/, `${page} must delete through the batch mutation`);
      assert.match(source, /tone: "danger"/, `${page} must confirm a batch delete`);
      assert.match(source, /for \(const id of succeeded\) next\.delete\(id\)/, `${page} must keep failed records selected`);
      assert.match(source, /<TaskSelectionBar/, `${page} must offer the batch action bar`);
    }
  });

  it("acts only on records the board is still showing", async () => {
    for (const page of ["BacklogPage", "RoutinesPage"]) {
      const source = await readFile(resolve(`web/src/components/${page}.tsx`), "utf8");
      assert.match(source, /pruneSelection\(selection, visibleIds\)/, `${page} must prune its selection`);
      assert.match(source, /selectedTasks\(filteredTasks, visibleSelection\)/, `${page} must delete only visible records`);
    }
  });

  it("provides complete batch copy in every locale", async () => {
    type BulkCopy = {
      delete_selected?: string;
      bulk_delete_title_one?: string;
      bulk_delete_title_other?: string;
      bulk_delete_body_one?: string;
      bulk_delete_body_other?: string;
      toast_bulk_deleted_one?: string;
      toast_bulk_deleted_other?: string;
    };

    for (const locale of ["en", "zh-CN"]) {
      const path = resolve(`web/src/i18n/locales/${locale}/translation.json`);
      const translation = JSON.parse(await readFile(path, "utf8")) as {
        backlog?: BulkCopy & { select_task?: string; select_all_tasks?: string; selected_one?: string; selected_other?: string; clear_selection?: string };
        routine?: BulkCopy & { select_routine?: string; select_all_routines?: string };
      };

      for (const section of [translation.backlog, translation.routine]) {
        assert.ok(section?.delete_selected, `${locale} is missing a batch delete action`);
        assert.ok(section?.bulk_delete_title_one && section.bulk_delete_title_other, `${locale} is missing batch delete titles`);
        assert.match(section?.bulk_delete_body_other ?? "", /\{\{count\}\}/, `${locale} batch copy must name the count`);
        assert.ok(section?.toast_bulk_deleted_one && section.toast_bulk_deleted_other, `${locale} is missing batch delete feedback`);
      }
      assert.ok(translation.backlog?.select_task, `${locale} is missing a task checkbox label`);
      assert.ok(translation.backlog?.select_all_tasks, `${locale} is missing a select-all label`);
      assert.ok(translation.backlog?.clear_selection, `${locale} is missing a clear-selection label`);
      assert.ok(translation.backlog?.selected_one && translation.backlog.selected_other, `${locale} is missing the selection count`);
      assert.ok(translation.routine?.select_routine, `${locale} is missing a routine checkbox label`);
      assert.ok(translation.routine?.select_all_routines, `${locale} is missing a routine select-all label`);
    }
  });
});
