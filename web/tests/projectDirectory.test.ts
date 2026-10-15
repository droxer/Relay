import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  expandProject,
  isProjectExpanded,
  projectDirectoryState,
  projectEmptyKey,
  projectFolderSelection,
  projectFolderTone,
  readProjectExpansion,
  toggleProjectExpansion,
  writeProjectExpansion,
  projectExpansionKey,
  mergeProjectIntoProjects,
} from "../src/lib/projectDirectory.js";
import type { ProjectRecord } from "../src/types.js";

function project(id: string, archivedAt?: string): ProjectRecord {
  return {
    id,
    ownerUserId: "emp-1",
    name: id,
    computerId: "device:mac:one",
    workspaceLayout: "project",
    workspaceSubpath: id,
    leadAgentId: null,
    members: [],
    enabled: true,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(archivedAt ? { archivedAt } : {}),
  };
}

describe("project directory expansion", () => {
  it("inserts a newly created project before the next background refetch", () => {
    const existing = project("existing");
    const created = project("created");
    created.name = "Created";

    assert.deepEqual(mergeProjectIntoProjects([existing], created), [created, existing]);
  });

  it("expands an active project by default", () => {
    assert.equal(isProjectExpanded(project("p1"), {}), true);
  });

  it("collapses an archived project by default", () => {
    assert.equal(isProjectExpanded(project("p1", "2026-01-02T00:00:00.000Z"), {}), false);
  });

  it("honours an explicit choice over the archived default", () => {
    const archived = project("p1", "2026-01-02T00:00:00.000Z");
    assert.equal(isProjectExpanded(archived, { p1: true }), true);
    assert.equal(isProjectExpanded(project("p2"), { p2: false }), false);
  });

  // The regression this whole module exists for: selection used to force the
  // expanded state, which left the chevron on the open project inert.
  it("lets the selected project collapse", () => {
    const selected = expandProject({}, "p1");
    assert.equal(isProjectExpanded(project("p1"), selected), true);
    const afterToggle = toggleProjectExpansion(selected, project("p1"));
    assert.equal(isProjectExpanded(project("p1"), afterToggle), false);
  });

  it("toggles back and forth from the default state", () => {
    const once = toggleProjectExpansion({}, project("p1"));
    assert.equal(isProjectExpanded(project("p1"), once), false);
    const twice = toggleProjectExpansion(once, project("p1"));
    assert.equal(isProjectExpanded(project("p1"), twice), true);
  });

  it("does not mutate the expansion it was handed", () => {
    const before = { p1: true };
    toggleProjectExpansion(before, project("p1"));
    expandProject(before, "p2");
    assert.deepEqual(before, { p1: true });
  });

  it("selecting an already-expanded project leaves the record untouched", () => {
    const collapsed = { p1: false, p2: true };
    assert.deepEqual(expandProject(collapsed, "p2"), { p1: false, p2: true });
  });
});

describe("project directory expansion storage", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => { storage.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
    (globalThis as { window?: Window }).window = {} as Window;
  });

  it("round-trips through localStorage", () => {
    writeProjectExpansion({ p1: false, p2: true });
    assert.deepEqual(readProjectExpansion(), { p1: false, p2: true });
  });

  it("returns an empty record when nothing is stored", () => {
    assert.deepEqual(readProjectExpansion(), {});
  });

  it("survives corrupt stored JSON", () => {
    storage.set(projectExpansionKey, "{not json");
    assert.deepEqual(readProjectExpansion(), {});
  });

  it("ignores a stored value of the wrong shape", () => {
    storage.set(projectExpansionKey, JSON.stringify(["p1"]));
    assert.deepEqual(readProjectExpansion(), {});
  });

  it("drops non-boolean entries rather than trusting them", () => {
    storage.set(projectExpansionKey, JSON.stringify({ p1: true, p2: "yes", p3: false }));
    assert.deepEqual(readProjectExpansion(), { p1: true, p3: false });
  });

  it("is inert without a window", () => {
    const globals = globalThis as { window?: Window };
    const saved = globals.window;
    delete globals.window;
    try {
      assert.deepEqual(readProjectExpansion(), {});
      writeProjectExpansion({ p1: true });
    } finally {
      globals.window = saved;
    }
  });
});

describe("project folder aggregate tone", () => {
  it("stays silent while the folder is expanded", () => {
    // Expanded, every thread shows its own pip; the folder dot would restate it.
    assert.equal(projectFolderTone({ needsYou: 2, running: 1, expanded: true }), undefined);
  });

  it("reports the running tone when collapsed", () => {
    assert.equal(projectFolderTone({ needsYou: 0, running: 1, expanded: false }), "run");
  });

  it("reports the attention tone when collapsed", () => {
    assert.equal(projectFolderTone({ needsYou: 1, running: 0, expanded: false }), "attn");
  });

  it("prefers attention over running when a project holds both", () => {
    assert.equal(projectFolderTone({ needsYou: 1, running: 2, expanded: false }), "attn");
  });

  it("stays silent for a settled project", () => {
    assert.equal(projectFolderTone({ needsYou: 0, running: 0, expanded: false }), undefined);
  });
});

describe("project folder selection", () => {
  const args = (over: Partial<Parameters<typeof projectFolderSelection>[0]> = {}) => ({
    projectId: "p1",
    selectedProjectId: "p1",
    selectedSessionId: undefined as string | undefined,
    threadIds: ["s1", "s2"],
    ...over,
  });

  it("marks nothing when another project is selected", () => {
    assert.equal(projectFolderSelection(args({ selectedProjectId: "p2" })), null);
  });

  it("marks nothing when no project is selected", () => {
    assert.equal(projectFolderSelection(args({ selectedProjectId: null })), null);
  });

  it("selects the folder when the project itself is the destination", () => {
    assert.equal(projectFolderSelection(args()), "selected");
  });

  // The regression: opening a thread also routes to its project, so the folder
  // used to take the selected wash too — three rows reading as one selection.
  it("defers to the thread when one of its own threads is open", () => {
    assert.equal(projectFolderSelection(args({ selectedSessionId: "s2" })), "ancestor");
  });

  it("stays selected when the open thread belongs to a different project", () => {
    assert.equal(projectFolderSelection(args({ selectedSessionId: "other" })), "selected");
  });

  it("stays selected when the project holds no threads at all", () => {
    assert.equal(projectFolderSelection(args({ threadIds: [], selectedSessionId: "s1" })), "selected");
  });
});

describe("project folder empty line", () => {
  it("says nothing when the project has threads", () => {
    assert.equal(projectEmptyKey({ threadCount: 3, hasQuery: false }), null);
    assert.equal(projectEmptyKey({ threadCount: 3, hasQuery: true }), null);
  });

  // The count badge already reads 0; a sentence repeating it earns nothing.
  it("says nothing for a genuinely empty project", () => {
    assert.equal(projectEmptyKey({ threadCount: 0, hasQuery: false }), null);
  });

  // "No threads in this project yet" is false here — it has threads, none match.
  it("explains an empty result under an active search", () => {
    assert.equal(projectEmptyKey({ threadCount: 0, hasQuery: true }), "project.no_matching_threads");
  });
});

/* The rail shows the same collection the project detail pane does, and that
   pane already distinguishes loading / error / not-found. The rail used to
   collapse all three into "No projects yet · Create project", so a slow or
   failed fetch invited the user to create a project they may well already
   have. */
describe("projectDirectoryState", () => {
  const ready = { projectCount: 2, collectionStatus: "ready" as const, hasQuery: false };

  it("renders the folders whenever there are any", () => {
    assert.equal(projectDirectoryState(ready), "ready");
  });

  // Poll refetches re-enter "loading" with the rail already populated; blanking
  // the folders to a spinner every few seconds would be worse than the bug.
  it("keeps a populated rail through a background refetch", () => {
    assert.equal(projectDirectoryState({ ...ready, collectionStatus: "loading" }), "ready");
    assert.equal(projectDirectoryState({ ...ready, collectionStatus: "error" }), "ready");
  });

  it("says it is loading rather than offering to create", () => {
    assert.equal(
      projectDirectoryState({ projectCount: 0, collectionStatus: "loading", hasQuery: false }),
      "loading",
    );
  });

  it("reports a failed fetch instead of an empty roster", () => {
    assert.equal(
      projectDirectoryState({ projectCount: 0, collectionStatus: "error", hasQuery: false }),
      "error",
    );
  });

  // A failure is the honest answer even mid-search: the query did not empty
  // the list, the request did.
  it("prefers the failure over the search explanation", () => {
    assert.equal(
      projectDirectoryState({ projectCount: 0, collectionStatus: "error", hasQuery: true }),
      "error",
    );
  });

  it("separates a filtered-empty rail from a genuinely empty one", () => {
    assert.equal(
      projectDirectoryState({ projectCount: 0, collectionStatus: "ready", hasQuery: true }),
      "filtered-empty",
    );
    assert.equal(
      projectDirectoryState({ projectCount: 0, collectionStatus: "ready", hasQuery: false }),
      "empty",
    );
  });
});
