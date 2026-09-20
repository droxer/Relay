import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { projectThreadBuckets, threadsForDirectory, type ThreadItem } from "../src/lib/threads.js";
import type { ProjectRecord, RelaySession } from "../src/types.js";

function project(id: string, name: string, archivedAt?: string): ProjectRecord {
  return {
    id,
    name,
    ownerEmployeeId: "employee-1",
    computerId: "device:employee-1:main",
    workspaceLayout: "project",
    workspaceSubpath: `projects/${id}`,
    leadAgentId: "agent-1",
    members: [],
    enabled: true,
    version: 1,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function thread(id: string, projectId?: string): ThreadItem {
  return {
    session: {
      id,
      projectId,
      workspacePath: "/workspace",
      taskGoal: id,
      participants: [],
      status: "completed",
      phase: "completed",
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
      agentRuns: [],
      artifacts: [],
      decisions: [],
      collaborationRounds: [],
      events: [],
    } satisfies RelaySession,
  };
}

describe("project thread buckets", () => {
  it("keeps empty and archived projects and sends legacy or unknown project threads to Unclassified", () => {
    const result = projectThreadBuckets(
      [thread("alpha-thread", "alpha"), thread("old-thread", "old"), thread("legacy"), thread("orphan", "deleted")],
      [project("zeta", "Zeta"), project("alpha", "Alpha"), project("old", "Old", "2026-08-15T01:00:00Z")],
    );

    assert.deepEqual(result.projects.map(({ project, threads }) => [project.id, threads.map((item) => item.session.id)]), [
      ["alpha", ["alpha-thread"]],
      ["zeta", []],
      ["old", ["old-thread"]],
    ]);
    assert.deepEqual(result.unclassified.map((item) => item.session.id), ["legacy", "orphan"]);
  });

  it("separates independent conversations from project conversations", () => {
    const projects = [project("alpha", "Alpha")];
    const threads = [thread("project-thread", "alpha"), thread("independent"), thread("orphan", "deleted")];

    assert.deepEqual(
      threadsForDirectory(threads, projects, "projects").map((item) => item.session.id),
      ["project-thread"],
    );
    assert.deepEqual(
      threadsForDirectory(threads, projects, "threads").map((item) => item.session.id),
      ["independent", "orphan"],
    );
  });

  it("exposes separate Threads, Projects, and Tasks destinations", async () => {
    const sideNavSource = await readFile(resolve("web/src/components/SideNav.tsx"), "utf8");

    assert.match(sideNavSource, /href=\{hrefForRoute\("main"\)\}/);
    assert.match(sideNavSource, /aria-label=\{t\("nav\.threads"\)\}/);
    assert.match(sideNavSource, /<span className="sidenav-label sr-only">\{t\("nav\.threads"\)\}<\/span>/);
    assert.match(sideNavSource, /href=\{hrefForRoute\("projects"\)\}/);
    assert.match(sideNavSource, /aria-label=\{t\("nav\.backlog"\)\}/);
    assert.match(sideNavSource, /<span className="sidenav-label sr-only">\{t\("nav\.backlog"\)\}<\/span>/);
  });

  it("exposes project settings from the project page", async () => {
    const pageSource = await readFile(resolve("web/src/components/ProjectWorkspacePage.tsx"), "utf8");
    const drawerSource = await readFile(resolve("web/src/components/ProjectDrawer.tsx"), "utf8");

    assert.match(pageSource, /onOpenSettings/);
    assert.match(pageSource, /\{t\("project\.edit"\)\}/);
    assert.match(drawerSource, /updateProjectMutation\.mutateAsync/);
    assert.match(drawerSource, /archiveProjectMutation\.mutateAsync/);
  });
});
