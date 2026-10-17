import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_WORKSPACE_BROWSE_PATH,
  parseWorkspaceBrowsePath,
  serializeWorkspaceBrowsePath,
  workspaceFileTabForPath,
  workspaceTabRootFor,
} from "../src/lib/workspaceFileTabs.js";

describe("workspace file tab for a browse path", () => {
  it("names the tab a path sits under", () => {
    assert.equal(workspaceFileTabForPath("artifacts"), "artifacts");
    assert.equal(workspaceFileTabForPath("artifacts/report.md"), "artifacts");
    assert.equal(workspaceFileTabForPath("threads/t-1"), "activities");
  });

  it("names no tab for the workspace root or a path outside both areas", () => {
    assert.equal(workspaceFileTabForPath(""), null);
    assert.equal(workspaceFileTabForPath("src"), null);
    assert.equal(workspaceFileTabForPath("artifacts-old"), null);
  });

  it("names the tab only when the path is exactly a tab root", () => {
    assert.equal(workspaceTabRootFor("artifacts"), "artifacts");
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
    assert.equal(serializeWorkspaceBrowsePath("threads/t-1"), "threads/t-1");
    assert.equal(parseWorkspaceBrowsePath("threads/t-1"), "threads/t-1");
  });
});
