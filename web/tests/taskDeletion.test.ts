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

  it("keeps deletion behind each record surface and a danger confirmation", async () => {
    const backlogSource = await readFile(resolve("web/src/components/BacklogPage.tsx"), "utf8");
    const routineSource = await readFile(resolve("web/src/components/RoutinesPage.tsx"), "utf8");
    // The delete button lives with the fields, which both the backlog's
    // drawer and the routine detail pane mount from TaskBoardForm.
    const drawerSource = await readFile(resolve("web/src/components/task-board/TaskBoardForm.tsx"), "utf8");

    for (const source of [backlogSource, routineSource]) {
      assert.match(source, /tone: "danger"/);
      assert.match(source, /deleteTaskMutation\.mutateAsync/);
      assert.match(source, /onDelete=\{form\.id/);
    }
    assert.match(drawerSource, /variant="destructive"/);
    assert.match(drawerSource, /disabled=\{busy\}/);
    assert.match(drawerSource, /routine\.delete_task/);
    assert.match(drawerSource, /routine\.deleting/);
  });
});
