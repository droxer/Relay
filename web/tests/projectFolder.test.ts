import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RelayApiError } from "../src/api.js";
import {
  computerLinksFolders,
  folderFieldUnavailableKey,
  folderPathLooksValid,
  projectFolderErrorKey,
} from "../src/lib/projectFolder.js";

describe("project folder linking", () => {
  it("is offered only on computers that advertise it", () => {
    assert.equal(computerLinksFolders({ capabilities: ["project-workspaces", "project-links"] }), true);
    assert.equal(computerLinksFolders({ capabilities: ["project-workspaces"] }), false);
    assert.equal(computerLinksFolders({}), false);
    assert.equal(computerLinksFolders(undefined), false);
  });

  it("names why the folder field cannot be used yet, so it is never silently hidden", () => {
    assert.equal(folderFieldUnavailableKey(undefined), "project.folder_choose_computer");
    assert.equal(folderFieldUnavailableKey({ capabilities: ["project-workspaces"] }), "project.folder_unsupported");
    assert.equal(folderFieldUnavailableKey({ capabilities: ["project-workspaces", "project-links"] }), null);
  });

  it("accepts an empty field or an absolute path", () => {
    for (const path of ["", "  ", "/Users/me/code/app", "C:\\code\\app", "d:/code"]) {
      assert.equal(folderPathLooksValid(path), true, path);
    }
    for (const path of ["code/app", "~/code", "C:code", "./app"]) {
      assert.equal(folderPathLooksValid(path), false, path);
    }
  });

  it("translates the computer's refusal codes and ignores unrelated errors", () => {
    assert.equal(
      projectFolderErrorKey(new RelayApiError("outside", 422, "project_workspace_not_allowed")),
      "project.folder_not_allowed",
    );
    assert.equal(
      projectFolderErrorKey(new RelayApiError("offline", 409, "project_computer_offline")),
      "project.folder_offline",
    );
    assert.equal(projectFolderErrorKey(new RelayApiError("taken", 409, "project_name_taken")), null);
    assert.equal(projectFolderErrorKey(new Error("network")), null);
    assert.equal(projectFolderErrorKey("project_workspace_not_found"), null);
  });
});
