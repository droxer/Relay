import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RelayArtifact } from "relay-core";

import {
  artifactDownloadName,
  artifactFileName,
  artifactRawHref,
  artifactRenderMode,
  artifactShowsKind,
  formatArtifactDate,
  workspaceFilePreviewMode,
} from "../src/lib/artifactPreview.js";

function artifact(overrides: Partial<RelayArtifact> = {}): RelayArtifact {
  return {
    id: "art_1",
    kind: "workspace_file",
    title: "report",
    path: "/workspace/report.md",
    createdAt: "2026-08-09T10:00:00.000Z",
    contentType: "text/markdown",
    ...overrides,
  };
}

describe("workspaceFilePreviewMode", () => {
  it("maps image content types to an inline image preview", () => {
    assert.equal(workspaceFilePreviewMode("image/png"), "image");
    assert.equal(workspaceFilePreviewMode("image/svg+xml"), "image");
    assert.equal(workspaceFilePreviewMode("IMAGE/JPEG"), "image");
  });

  it("maps pdf and html to frame previews", () => {
    assert.equal(workspaceFilePreviewMode("application/pdf"), "pdf");
    assert.equal(workspaceFilePreviewMode("text/html"), "html");
    assert.equal(workspaceFilePreviewMode("text/html; charset=utf-8"), "html");
  });

  it("maps text-like content to a plain text preview", () => {
    assert.equal(workspaceFilePreviewMode("text/csv"), "text");
    assert.equal(workspaceFilePreviewMode("text/tab-separated-values"), "text");
    assert.equal(workspaceFilePreviewMode("application/json"), "text");
  });

  it("falls back to none for binary documents and missing types", () => {
    assert.equal(workspaceFilePreviewMode("application/vnd.openxmlformats-officedocument.presentationml.presentation"), "none");
    assert.equal(workspaceFilePreviewMode("application/zip"), "none");
    assert.equal(workspaceFilePreviewMode(undefined), "none");
    assert.equal(workspaceFilePreviewMode(""), "none");
  });
});

describe("artifactRenderMode", () => {
  it("gives agent-authored prose kinds a Markdown reading", () => {
    for (const kind of ["plan", "review", "summary"] as const) {
      assert.equal(artifactRenderMode(artifact({ kind, contentType: undefined })), "markdown");
    }
  });

  it("leaves raw stream kinds with only their source reading", () => {
    for (const kind of ["diff", "command_log", "test_output", "agent_output"] as const) {
      assert.equal(artifactRenderMode(artifact({ kind, contentType: undefined })), "none");
    }
  });

  it("reads Markdown workspace files off the filename, not the text content type", () => {
    assert.equal(
      artifactRenderMode(artifact({ contentType: "text/markdown", workspaceRelativePath: "docs/plan.md" })),
      "markdown",
    );
    assert.equal(
      artifactRenderMode(artifact({ contentType: "text/plain", workspaceRelativePath: "notes.MARKDOWN" })),
      "markdown",
    );
    assert.equal(
      artifactRenderMode(artifact({ contentType: "text/plain", workspaceRelativePath: "run.log" })),
      "none",
    );
  });

  it("gives HTML workspace files a document reading from the content type alone", () => {
    assert.equal(
      artifactRenderMode(artifact({ contentType: "text/html; charset=utf-8", workspaceRelativePath: "out" })),
      "html",
    );
  });

  it("offers no switch for files that have no source reading or no preview", () => {
    assert.equal(artifactRenderMode(artifact({ contentType: "image/png", path: "chart.png" })), "none");
    assert.equal(artifactRenderMode(artifact({ contentType: "application/pdf", path: "report.pdf" })), "none");
    assert.equal(artifactRenderMode(artifact({ contentType: "application/zip", path: "bundle.zip" })), "none");
    assert.equal(artifactRenderMode(artifact({ contentType: undefined, path: "mystery" })), "none");
  });

  it("does not mistake a dotted title for an extension when a path exists", () => {
    assert.equal(
      artifactRenderMode(artifact({ contentType: "text/plain", title: "summary.md", path: "/w/out.txt" })),
      "none",
    );
  });
});

describe("artifactFileName", () => {
  it("prefers the workspace-relative path over the absolute path and title", () => {
    assert.equal(
      artifactFileName(artifact({ workspaceRelativePath: "docs/plan.md", path: "/workspace/docs/plan.md" })),
      "docs/plan.md",
    );
    assert.equal(artifactFileName(artifact({ path: "/workspace/report.md" })), "/workspace/report.md");
  });
});

describe("artifactRawHref", () => {
  it("URL-encodes both identifiers", () => {
    assert.equal(artifactRawHref("ses 1", "art/2"), "/api/v1/threads/ses%201/artifacts/art%2F2");
  });
});

describe("artifactDownloadName", () => {
  it("replaces filesystem-reserved characters and collapses whitespace", () => {
    assert.equal(artifactDownloadName('notes/2026: "draft"?.md'), "notes 2026 draft .md");
  });

  it("falls back to a stable name when nothing usable is left", () => {
    assert.equal(artifactDownloadName(" /\\ "), "artifact");
  });
});

describe("artifactShowsKind", () => {
  it("hides the kind tag for workspace files, whose name already says what they are", () => {
    assert.equal(artifactShowsKind("workspace_file"), false);
  });

  it("keeps it for kinds a title does not name", () => {
    for (const kind of ["plan", "diff", "review", "summary", "command_log", "test_output", "agent_output"] as const) {
      assert.equal(artifactShowsKind(kind), true, kind);
    }
  });
});

describe("formatArtifactDate", () => {
  it("formats a timestamp with month, day, and time so versions differ", () => {
    const earlier = formatArtifactDate("2026-08-09T10:00:00.000Z", "en");
    const later = formatArtifactDate("2026-08-09T10:30:00.000Z", "en");
    assert.match(earlier, /Aug/);
    assert.notEqual(earlier, later);
  });

  it("returns empty for a missing value and the raw input when unparseable", () => {
    assert.equal(formatArtifactDate(undefined, "en"), "");
    assert.equal(formatArtifactDate("not a date", "en"), "not a date");
  });
});
