import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  durabilityTone,
  producedFilesState,
  secondaryTierEntries,
} from "../src/components/task-board/producedFileRows.js";
import type {
  ProducedFile,
  TaskFilesResponse,
  WorkspaceFileEntry,
} from "../src/types.js";

function producedFile(path: string, extra: Partial<ProducedFile> = {}): ProducedFile {
  return {
    id: path,
    kind: "workspace_file",
    title: path.split("/").at(-1) as string,
    sessionId: "s1",
    workspaceRelativePath: path,
    currency: "current",
    ...extra,
  } as ProducedFile;
}

function entry(path: string): WorkspaceFileEntry {
  return {
    name: path.split("/").at(-1) as string,
    path,
    kind: "file",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("producedFileRows", () => {
  it("keeps a file out of the second tier once a run claims it", () => {
    const produced = [producedFile("report.md")];
    const live = [entry("report.md"), entry("main.py"), entry(".gitignore")];

    assert.deepEqual(
      secondaryTierEntries(produced, live).map((item) => item.path),
      ["main.py", ".gitignore"],
    );
  });

  it("distinguishes an unreachable computer from a task that produced nothing", () => {
    const offline: TaskFilesResponse = {
      taskId: "t1",
      produced: [producedFile("report.md")],
      live: { status: "offline", path: "", entries: [] },
    };
    assert.equal(
      producedFilesState({ isLoading: false, error: null, data: offline }),
      "ready",
    );

    const nothing: TaskFilesResponse = {
      taskId: "t1",
      produced: [],
      live: { status: "ok", path: "", entries: [] },
    };
    assert.equal(
      producedFilesState({ isLoading: false, error: null, data: nothing }),
      "empty",
    );
    assert.equal(
      producedFilesState({ isLoading: true, error: null, data: undefined }),
      "loading",
    );
    assert.equal(
      producedFilesState({
        isLoading: false,
        error: new Error("nope"),
        data: undefined,
      }),
      "failed",
    );
  });

  it("reads durability from the snapshot reason rather than the file type", () => {
    assert.equal(durabilityTone(producedFile("report.md")), "stored");
    assert.equal(
      durabilityTone(
        producedFile("src/main.py", {
          snapshotSkipped: "not-snapshotable-type",
        }),
      ),
      "live-only",
    );
    assert.equal(
      durabilityTone(
        producedFile("bundle.zip", { snapshotSkipped: "too-large" }),
      ),
      "live-only",
    );
  });
});
