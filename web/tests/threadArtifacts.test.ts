import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { latestThreadArtifacts, visibleThreadArtifacts } from "../src/lib/threadArtifacts.js";
import type { RelayArtifact, RelaySession } from "../src/types.js";

const timestamp = "2026-06-19T12:00:00.000Z";

function artifact(input: Partial<RelayArtifact> & Pick<RelayArtifact, "id" | "kind" | "createdAt">): RelayArtifact {
  return {
    title: input.id,
    path: `/tmp/${input.id}`,
    ...input,
  };
}

function session(artifacts: RelayArtifact[]): RelaySession {
  return {
    id: "ses_1",
    workspacePath: "/workspace",
    ownerUserId: "alice",
    taskGoal: "Build artifact drawer",
    participants: ["human", "claude"],
    status: "completed",
    phase: "done",
    createdAt: timestamp,
    updatedAt: timestamp,
    agentRuns: [],
    artifacts,
    decisions: [],
    collaborationRounds: [],
    events: [],
  };
}

describe("visibleThreadArtifacts", () => {
  it("returns an empty list without a session", () => {
    assert.deepEqual(visibleThreadArtifacts(undefined), []);
  });

  it("excludes command logs", () => {
    const visible = visibleThreadArtifacts(session([
      artifact({ id: "art_review", kind: "review", createdAt: "2026-06-19T12:01:00.000Z" }),
      artifact({ id: "art_log", kind: "command_log", createdAt: "2026-06-19T12:02:00.000Z" }),
    ]));

    assert.deepEqual(visible.map((item) => item.id), ["art_review"]);
  });

  it("sorts newest first", () => {
    const visible = visibleThreadArtifacts(session([
      artifact({ id: "art_old", kind: "summary", createdAt: "2026-06-19T12:01:00.000Z" }),
      artifact({ id: "art_new", kind: "diff", createdAt: "2026-06-19T12:03:00.000Z" }),
      artifact({ id: "art_mid", kind: "review", createdAt: "2026-06-19T12:02:00.000Z" }),
    ]));

    assert.deepEqual(visible.map((item) => item.id), ["art_new", "art_mid", "art_old"]);
  });

  it("keeps every version of a generated file so older ones stay openable", () => {
    const visible = visibleThreadArtifacts(session([
      artifact({
        id: "art_file_a",
        kind: "workspace_file",
        title: "report.md",
        path: "/workspace/report.md",
        workspaceRelativePath: "report.md",
        createdAt: "2026-06-19T12:01:00.000Z",
      }),
      artifact({
        id: "art_file_b",
        kind: "workspace_file",
        title: "report.md",
        path: "/workspace/report.md",
        workspaceRelativePath: "report.md",
        createdAt: "2026-06-19T12:02:00.000Z",
      }),
    ]));

    assert.deepEqual(visible.map((item) => item.id), ["art_file_b", "art_file_a"]);
  });
});

describe("latestThreadArtifacts", () => {
  function file(id: string, relative: string, createdAt: string): RelayArtifact {
    return artifact({
      id,
      kind: "workspace_file",
      title: relative,
      path: `/workspace/${relative}`,
      workspaceRelativePath: relative,
      createdAt,
    });
  }

  it("lists each generated file once, at its newest version", () => {
    const visible = visibleThreadArtifacts(session([
      file("art_md_old", "HANDOFF.md", "2026-06-19T12:01:00.000Z"),
      file("art_json_old", "HANDOFF.json", "2026-06-19T12:01:00.000Z"),
      file("art_md_new", "HANDOFF.md", "2026-06-19T12:04:00.000Z"),
      file("art_json_new", "HANDOFF.json", "2026-06-19T12:04:00.000Z"),
    ]));

    assert.deepEqual(latestThreadArtifacts(visible).map((item) => item.id), ["art_md_new", "art_json_new"]);
  });

  it("keeps files that share a name but not a path", () => {
    const latest = latestThreadArtifacts([
      file("art_root", "README.md", "2026-06-19T12:01:00.000Z"),
      file("art_docs", "docs/README.md", "2026-06-19T12:02:00.000Z"),
    ]);

    assert.deepEqual(latest.map((item) => item.id), ["art_root", "art_docs"]);
  });

  it("passes non-file artifacts through untouched", () => {
    const latest = latestThreadArtifacts([
      artifact({ id: "art_review_a", kind: "review", path: "/tmp/review", createdAt: "2026-06-19T12:01:00.000Z" }),
      artifact({ id: "art_review_b", kind: "review", path: "/tmp/review", createdAt: "2026-06-19T12:02:00.000Z" }),
    ]);

    assert.deepEqual(latest.map((item) => item.id), ["art_review_a", "art_review_b"]);
  });
});
