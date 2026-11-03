import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  githubErrorKey,
  importableIssues,
  markImported,
  MAX_IMPORT_ISSUES,
  mergeIssuePages,
  safeGitHubUrl,
  toggleAllImportable,
} from "../src/lib/githubImport.js";
import type { GitHubImportResponse, GitHubIssuePreview, RelayTask } from "../src/types.js";

function issue(number: number, importedTaskId: string | null = null): GitHubIssuePreview {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/octo/hello/issues/${number}`,
    state: "open",
    labels: [],
    author: "octocat",
    comments: 0,
    importedTaskId,
  };
}

describe("github import helpers", () => {
  it("names known error codes and falls back for the rest", () => {
    assert.equal(githubErrorKey("github_rate_limited"), "github_import.errors.github_rate_limited");
    assert.equal(githubErrorKey("issue_needs_project"), "github_import.errors.generic");
    assert.equal(githubErrorKey(undefined), "github_import.errors.generic");
  });

  it("appends a later page without repeating an issue", () => {
    const merged = mergeIssuePages([issue(3), issue(2)], [issue(2), issue(1)]);
    assert.deepEqual(merged.map((item) => item.number), [3, 2, 1]);
  });

  it("offers only issues the destination does not hold", () => {
    assert.deepEqual(importableIssues([issue(1), issue(2, "task-2")]).map((item) => item.number), [1]);
  });

  it("selects every importable issue, capped, then clears", () => {
    const many = Array.from({ length: MAX_IMPORT_ISSUES + 5 }, (_, index) => issue(index + 1));
    const all = toggleAllImportable(new Set(), [...many, issue(999, "task")]);
    assert.equal(all.size, MAX_IMPORT_ISSUES);
    assert.equal(all.has(999), false);
    assert.equal(toggleAllImportable(all, many).size, 0);
    const few = [issue(1), issue(2)];
    assert.equal(toggleAllImportable(new Set([1, 2]), few).size, 0);
    assert.deepEqual([...toggleAllImportable(new Set([1]), few)], [1, 2]);
  });

  it("marks created and already-imported issues with their task", () => {
    const result: GitHubImportResponse = {
      created: [{ id: "task-1", externalSource: { provider: "github", ref: "github:octo/hello#1", repository: "octo/hello", number: 1, url: "" } } as RelayTask],
      skipped: [{ number: 2, reason: "already_imported", taskId: "task-2" }, { number: 3, reason: "pull_request" }],
      failed: [{ number: 4, reason: "github_not_found" }],
    };
    const marked = markImported([issue(1), issue(2), issue(3), issue(4)], result);
    assert.deepEqual(marked.map((item) => item.importedTaskId), ["task-1", "task-2", null, null]);
  });

  it("renders only github.com https links", () => {
    assert.equal(safeGitHubUrl("https://github.com/octo/hello/issues/1"), "https://github.com/octo/hello/issues/1");
    assert.equal(safeGitHubUrl("javascript:alert(1)"), undefined);
    assert.equal(safeGitHubUrl("https://github.com.evil.example/x"), undefined);
    assert.equal(safeGitHubUrl("http://github.com/x"), undefined);
    assert.equal(safeGitHubUrl(undefined), undefined);
  });
});
