import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  orderedProjectMembers,
  parseProjectPageTab,
  projectActivitiesState,
  scopeProjectActivities,
  projectMemberState,
  projectPageActions,
  projectReadOnly,
  resolveProjectOverviewState,
  showThreadChrome,
  agentsEligibleForProject,
} from "../src/lib/projectPage.js";
import type {
  AgentPlacement,
  EmployeeAgent,
  ProjectMember,
  ProjectRecord,
  WorkspaceBriefResponse,
} from "../src/types.js";

const member = (agentId: string, enabled = true): ProjectMember => ({
  agentId,
  role: "implementer",
  responsibilities: `${agentId} responsibilities`,
  enabled,
});

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "project-1",
  ownerEmployeeId: "employee-1",
  name: "Project one",
  computerId: "device:employee-1:main",
  workspaceLayout: "project",
  workspaceSubpath: "projects/project-1",
  leadAgentId: "lead",
  members: [member("reviewer"), member("lead")],
  enabled: true,
  version: 1,
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
  ...overrides,
});

const agent = (overrides: Partial<EmployeeAgent> = {}): EmployeeAgent => ({
  id: "lead",
  supervisorEmployeeId: "employee-1",
  displayName: "Lead",
  executorKind: "codex",
  skillPolicy: {},
  toolPolicy: {},
  modelPolicy: {},
  enabled: true,
  version: 1,
  availability: "ready",
  placements: [],
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
  ...overrides,
});

describe("project page behavior", () => {
  /* Roving keyboard navigation is no longer tested here: the page's tablist
     is a base-ui Tabs now, which owns arrow/Home/End itself. What stays ours
     is canonicalizing the tab named in the URL. */
  it("canonicalizes the tab named in the URL", () => {
    // A project opens on its General tab; the retired Agents id lands there.
    assert.equal(parseProjectPageTab(null), "general");
    assert.equal(parseProjectPageTab("unknown"), "general");
    assert.equal(parseProjectPageTab("profile"), "general");
    assert.equal(parseProjectPageTab("tasks"), "tasks");
    assert.equal(parseProjectPageTab("workspace"), "workspace");
  });

  it("anchors the lead while preserving the remaining stored roster order", () => {
    assert.deepEqual(
      orderedProjectMembers(project()).map((entry) => entry.agentId),
      ["lead", "reviewer"],
    );
  });

  it("preserves missing and deleted roster identities as unavailable", () => {
    assert.deepEqual(projectMemberState(member("missing"), undefined), {
      available: false,
      enabled: false,
      availability: "offline",
    });
    assert.equal(
      projectMemberState(member("lead"), agent({ deletedAt: "2026-08-16T00:00:00Z" })).available,
      false,
    );
    assert.deepEqual(projectMemberState(member("lead"), agent()), {
      available: true,
      enabled: true,
      availability: "ready",
    });
  });

  it("keeps settings available while restricting new work for archived and disabled projects", () => {
    assert.deepEqual(projectPageActions(project()), { settings: true, newThread: true });
    assert.deepEqual(
      projectPageActions(project({ archivedAt: "2026-08-16T00:00:00Z" })),
      { settings: true, newThread: false },
    );
    assert.deepEqual(
      projectPageActions(project({ enabled: false })),
      { settings: true, newThread: false },
    );
  });

  it("keeps project deep links out of chat through loading, error, and missing states", () => {
    const input = { showProjectOverview: true, project: null } as const;
    assert.equal(resolveProjectOverviewState({ ...input, collectionStatus: "loading" }), "loading");
    assert.equal(resolveProjectOverviewState({ ...input, collectionStatus: "error" }), "error");
    assert.equal(resolveProjectOverviewState({ ...input, collectionStatus: "ready" }), "not-found");
    assert.equal(
      resolveProjectOverviewState({ ...input, project: project(), collectionStatus: "error" }),
      "ready",
    );
    assert.equal(
      resolveProjectOverviewState({ ...input, showProjectOverview: false, collectionStatus: "ready" }),
      "hidden",
    );
  });

  it("removes thread-only chrome from the project dossier", () => {
    assert.equal(showThreadChrome(true), false);
    assert.equal(showThreadChrome(false), true);
  });

  it("distinguishes activity loading, error, and ready states", () => {
    assert.equal(projectActivitiesState({ isLoading: true, hasData: false, hasError: false }), "loading");
    assert.equal(projectActivitiesState({ isLoading: false, hasData: false, hasError: false }), "error");
    assert.equal(projectActivitiesState({ isLoading: false, hasData: false, hasError: true }), "error");
    assert.equal(projectActivitiesState({ isLoading: false, hasData: true, hasError: false }), "ready");
  });

  it("shows only activity that belongs to the current project", () => {
    const brief = {
      employeeId: "employee-1",
      projectId: "project-1",
      nodes: [],
      activeRuns: [
        {
          commandId: "command-1",
          sessionId: "session-1",
          runId: "run-1",
          agent: "codex",
          taskGoal: "Current project run",
          startedAt: "2026-08-16T00:00:00Z",
        },
        {
          commandId: "command-2",
          sessionId: "session-2",
          runId: "run-2",
          agent: "codex",
          taskGoal: "Other project run",
          startedAt: "2026-08-16T00:00:00Z",
        },
      ],
      sessions: [
        {
          id: "session-1",
          projectId: "project-1",
          taskGoal: "Current project thread",
          artifactCount: 0,
          runCount: 1,
        },
        {
          id: "session-2",
          projectId: "project-2",
          taskGoal: "Other project thread",
          artifactCount: 0,
          runCount: 1,
        },
        {
          id: "session-unscoped",
          taskGoal: "Unscoped thread",
          artifactCount: 0,
          runCount: 0,
        },
      ],
      tasks: [
        {
          id: "task-1",
          projectId: "project-1",
          title: "Current project task",
          isRoutine: false,
          routineEnabled: false,
          linkedSessionIds: [],
        },
        {
          id: "task-2",
          projectId: "project-2",
          title: "Other project task",
          isRoutine: false,
          routineEnabled: false,
          linkedSessionIds: [],
        },
      ],
      artifacts: [],
      metrics: {
        nodeCount: 0,
        activeRunCount: 2,
        sessionCount: 3,
        activeSessionCount: 2,
        taskCount: 2,
        activeTaskCount: 2,
        artifactCount: 0,
      },
      generatedAt: "2026-08-16T00:00:00Z",
    } satisfies WorkspaceBriefResponse;

    const scoped = scopeProjectActivities(brief, "project-1");

    assert.deepEqual(scoped.sessions.map((session) => session.id), ["session-1"]);
    assert.deepEqual(scoped.tasks.map((task) => task.id), ["task-1"]);
    assert.deepEqual(scoped.activeRuns.map((run) => run.runId), ["run-1"]);
  });

  it("offers only agents the backend would accept as project members", () => {
    const placement = (overrides: Partial<AgentPlacement> = {}): AgentPlacement => ({
      id: "placement-1",
      agentId: "agent-1",
      employeeId: "employee-1",
      daemonNodeId: "node-1",
      executorKind: "codex",
      desiredState: "active",
      status: "ready",
      priority: 0,
      agentVersion: 1,
      workspacePolicy: {},
      conditions: [],
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
      ...overrides,
    });
    const computerId = "device:employee-1:main";

    const eligible = [
      // Stable computer-id match, the common case.
      agent({ id: "by-computer", placements: [placement({ computerId: computerId })] }),
      // Legacy placement with no computer id falls back to the runtime node.
      agent({ id: "by-node", placements: [placement({ runtimeNodeId: "node-1" })] }),
      agent({ id: "by-daemon", placements: [placement({ daemonNodeId: "node-1" })] }),
    ];
    const rejected = [
      // Runtime node matches, but the placement names a DIFFERENT computer —
      // the backend rejects this as project_member_computer_mismatch.
      agent({ id: "wrong-computer", placements: [placement({ computerId: "device:employee-1:other", runtimeNodeId: "node-1" })] }),
      agent({ id: "draining", placements: [placement({ computerId: computerId, desiredState: "draining" })] }),
      agent({ id: "disabled", enabled: false, placements: [placement({ computerId: computerId })] }),
      agent({ id: "deleted", deletedAt: "2026-08-16T00:00:00Z", placements: [placement({ computerId: computerId })] }),
      agent({ id: "unplaced", placements: [] }),
    ];

    assert.deepEqual(
      agentsEligibleForProject([...eligible, ...rejected], computerId, "node-1").map((entry) => entry.id),
      ["by-computer", "by-node", "by-daemon"],
    );
  });
});

describe("projectReadOnly", () => {
  it("closes an archived or disabled project for work", () => {
    assert.equal(projectReadOnly(project()), false);
    assert.equal(projectReadOnly(project({ enabled: false })), true);
    assert.equal(projectReadOnly(project({ archivedAt: "2026-09-01T00:00:00Z" })), true);
  });

  it("treats a task with no project as open", () => {
    assert.equal(projectReadOnly(undefined), false);
    assert.equal(projectReadOnly(null), false);
  });
});
