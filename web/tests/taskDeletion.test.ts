import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

type DeleteCopy = {
  delete_task?: string;
  deleting?: string;
  delete_title?: string;
  delete_body?: string;
  toast_deleted?: string;
};

type Translation = {
  errors?: { task_execution_active?: string };
  backlog?: DeleteCopy;
  routine?: DeleteCopy;
};

describe("task deletion", () => {
  it("provides complete confirmation and success copy in every locale", async () => {
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const path = resolve(`web/src/i18n/locales/${locale}/translation.json`);
      const translation = JSON.parse(await readFile(path, "utf8")) as Translation;

      for (const section of [translation.backlog, translation.routine]) {
        assert.ok(section?.delete_task, `${locale} is missing a delete action`);
        assert.ok(section?.deleting, `${locale} is missing delete pending copy`);
        assert.ok(section?.delete_title, `${locale} is missing a delete title`);
        assert.match(section.delete_body ?? "", /\{\{title\}\}/, `${locale} delete copy must name the task`);
        assert.ok(section.toast_deleted, `${locale} is missing delete success feedback`);
      }
      assert.ok(
        translation.errors?.task_execution_active,
        `${locale} is missing active-work deletion feedback`,
      );
    }
  });

  it("keeps deletion behind each edit drawer and a danger confirmation", async () => {
    /* The backlog form is a shared controller now — the project board edits
       through the same one — so the guarantee is asserted where it lives. */
    const backlogSource = await readFile(resolve("web/src/hooks/useBacklogTaskForm.ts"), "utf8");
    const routineSource = await readFile(resolve("web/src/components/RoutinesPage.tsx"), "utf8");
    const drawerSource = await readFile(resolve("web/src/components/task-board/TaskDrawer.tsx"), "utf8");

    for (const source of [backlogSource, routineSource]) {
      assert.match(source, /tone: "danger"/);
      assert.match(source, /deleteTaskMutation\.mutateAsync/);
    }
    // Every surface that mounts the drawer only offers Delete on a saved task.
    for (const path of [
      "web/src/components/BacklogPage.tsx",
      "web/src/components/RoutinesPage.tsx",
    ]) {
      assert.match(await readFile(resolve(path), "utf8"), /onDelete=\{(taskForm\.)?form\.id/);
    }
    assert.match(drawerSource, /variant="destructive"/);

    /* The record surface deletes too, and its button has to mark itself the
       same way — it sat as a ghost beside Edit, and without a busy state a
       second click fired a second delete before the first had landed. */
    const recordActionsSource = await readFile(
      resolve("web/src/components/task-record/TaskRecordActions.tsx"),
      "utf8",
    );
    assert.match(recordActionsSource, /variant="destructive"/);
    assert.match(recordActionsSource, /loading=\{busyAction === "delete"\}/);
    const recordViewSource = await readFile(
      resolve("web/src/components/task-record/TaskRecordView.tsx"),
      "utf8",
    );
    assert.match(recordViewSource, /setBusyAction\("delete"\)/);
    assert.match(recordViewSource, /if \(busyAction \|\| !task\) return;/);

    assert.match(drawerSource, /disabled=\{busy\}/);
    assert.match(drawerSource, /routine\.delete_task/);
    assert.match(drawerSource, /routine\.deleting/);
  });
});
