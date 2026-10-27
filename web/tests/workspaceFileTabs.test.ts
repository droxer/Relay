import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_WORKSPACE_BROWSE_PATH,
  DEFAULT_WORKSPACE_FILE_ROOTS,
  PROJECT_WORKSPACE_FILE_ROOTS,
  parseWorkspaceBrowsePath,
  serializeWorkspaceBrowsePath,
  isWorkspaceInternalEntry,
  workspaceFileRoots,
  workspaceFileTabForPath,
  workspaceTabRootFor,
} from "../src/lib/workspaceFileTabs.js";

describe("workspace file roots", () => {
  it("keeps artifacts/ for a thread or task, and for an older response", () => {
    assert.deepEqual(workspaceFileRoots(undefined), { artifacts: "artifacts", activities: ".relay/threads" });
    assert.deepEqual(workspaceFileRoots("artifacts"), { artifacts: "artifacts", activities: ".relay/threads" });
  });

  it("roots one automation run at its own artifacts folder", () => {
    assert.deepEqual(workspaceFileRoots("artifacts/tsk_run"), { artifacts: "artifacts/tsk_run", activities: ".relay/threads" });
  });

  it("narrows one automation run's activity to its own thread's records", () => {
    const roots = workspaceFileRoots("artifacts/tsk_run", "ses_run");
    assert.deepEqual(roots, { artifacts: "artifacts/tsk_run", activities: ".relay/threads/ses_run" });
    assert.equal(workspaceTabRootFor(".relay/threads/ses_run", roots), "activities");
    assert.equal(workspaceFileTabForPath(".relay/threads/ses_run/HANDOFF.md", roots), "activities");
    assert.equal(workspaceFileTabForPath(".relay/threads/ses_other", roots), null);
    assert.deepEqual(workspaceFileRoots("artifacts/tsk_run", null), { artifacts: "artifacts/tsk_run", activities: ".relay/threads" });
  });

  it("makes the project directory itself the files root", () => {
    assert.equal(workspaceFileRoots(null), PROJECT_WORKSPACE_FILE_ROOTS);
    assert.equal(PROJECT_WORKSPACE_FILE_ROOTS.artifacts, "");
  });
});

describe("workspace file tab for a project path", () => {
  it("counts everything outside thread records as the project's files", () => {
    assert.equal(workspaceFileTabForPath("", PROJECT_WORKSPACE_FILE_ROOTS), "artifacts");
    assert.equal(workspaceFileTabForPath("src/app.ts", PROJECT_WORKSPACE_FILE_ROOTS), "artifacts");
    assert.equal(workspaceFileTabForPath(".relay/threads/t-1", PROJECT_WORKSPACE_FILE_ROOTS), "activities");
  });

  it("names the project root as the files tab root", () => {
    assert.equal(workspaceTabRootFor("", PROJECT_WORKSPACE_FILE_ROOTS), "artifacts");
    assert.equal(workspaceTabRootFor(".relay/threads", PROJECT_WORKSPACE_FILE_ROOTS), "activities");
    assert.equal(workspaceTabRootFor("src", PROJECT_WORKSPACE_FILE_ROOTS), null);
  });

  it("keeps the project root out of the URL and still round-trips it", () => {
    assert.equal(serializeWorkspaceBrowsePath("", ""), null);
    assert.equal(parseWorkspaceBrowsePath(null, ""), "");
    assert.equal(parseWorkspaceBrowsePath("/", ""), "");
    assert.equal(serializeWorkspaceBrowsePath("artifacts", ""), "artifacts");
  });
});

describe("workspace file tab for one automation run", () => {
  const roots = workspaceFileRoots("artifacts/tsk_run");
  it("scopes the artifacts tab to the run's folder", () => {
    assert.equal(workspaceFileTabForPath("artifacts/tsk_run", roots), "artifacts");
    assert.equal(workspaceFileTabForPath("artifacts/tsk_run/report.md", roots), "artifacts");
    assert.equal(workspaceFileTabForPath("artifacts/tsk_other", roots), null);
    assert.equal(workspaceTabRootFor("artifacts/tsk_run", roots), "artifacts");
    assert.equal(workspaceTabRootFor("artifacts", roots), null);
  });
});

describe("workspace file tab for a browse path", () => {
  it("names the tab a path sits under", () => {
    assert.equal(workspaceFileTabForPath("artifacts"), "artifacts");
    assert.equal(workspaceFileTabForPath("artifacts/report.md"), "artifacts");
    assert.equal(workspaceFileTabForPath(".relay/threads/t-1"), "activities");
    assert.equal(workspaceFileTabForPath(".threads/t-1"), "activities");
    assert.equal(workspaceFileTabForPath("threads/t-1"), "activities");
    assert.equal(workspaceFileTabForPath("threads/t-1", PROJECT_WORKSPACE_FILE_ROOTS), "activities");
  });

  it("names no tab for the workspace root or a path outside both areas", () => {
    assert.equal(workspaceFileTabForPath(""), null);
    assert.equal(workspaceFileTabForPath("src"), null);
    assert.equal(workspaceFileTabForPath("artifacts-old"), null);
  });

  it("names the tab only when the path is exactly a tab root", () => {
    assert.equal(workspaceTabRootFor("artifacts"), "artifacts");
    assert.equal(workspaceTabRootFor(".relay/threads"), "activities");
    assert.equal(workspaceTabRootFor(".threads"), "activities");
    assert.equal(workspaceTabRootFor(".relay"), null);
    assert.equal(workspaceTabRootFor("threads"), "activities");
    assert.equal(workspaceTabRootFor("artifacts/report"), null);
    assert.equal(workspaceTabRootFor(""), null);
  });
});

describe("workspace browse path in the URL", () => {
  it("opens the Artifacts tab when the URL names no path", () => {
    assert.equal(parseWorkspaceBrowsePath(null), DEFAULT_WORKSPACE_BROWSE_PATH);
    assert.equal(DEFAULT_WORKSPACE_BROWSE_PATH, "artifacts");
  });

  it("keeps the default out of the URL", () => {
    assert.equal(serializeWorkspaceBrowsePath("artifacts"), null);
  });

  it("round-trips the workspace root through a non-empty value", () => {
    const encoded = serializeWorkspaceBrowsePath("");
    assert.ok(encoded, "an empty param is dropped by URL canonicalization");
    assert.equal(parseWorkspaceBrowsePath(encoded), "");
  });

  it("round-trips any other folder unchanged", () => {
    assert.equal(serializeWorkspaceBrowsePath(".relay/threads/t-1"), ".relay/threads/t-1");
    assert.equal(parseWorkspaceBrowsePath(".relay/threads/t-1"), ".relay/threads/t-1");
  });
});

describe("project root listing", () => {
  it("hides Relay's own folders at the project root only", () => {
    for (const name of [".threads", "threads", "agents", ".relay"]) {
      assert.equal(isWorkspaceInternalEntry(name, "", PROJECT_WORKSPACE_FILE_ROOTS), true);
      assert.equal(isWorkspaceInternalEntry(name, "src", PROJECT_WORKSPACE_FILE_ROOTS), false);
      assert.equal(isWorkspaceInternalEntry(name, "", DEFAULT_WORKSPACE_FILE_ROOTS), false);
    }
    assert.equal(isWorkspaceInternalEntry("docs", "", PROJECT_WORKSPACE_FILE_ROOTS), false);
  });
});
