import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useThreadDirectory } from "../src/hooks/useThreadDirectory";
import { threadProjectFilterFor, type ThreadProjectFilter } from "../src/lib/threadProjectFilter";
import type { ProjectRecord, RelaySession, RelayTaskListItem } from "../src/types";

function session(id: string, taskGoal: string, projectId?: string): RelaySession {
  return { id, projectId, taskGoal, status: "completed", updatedAt: "2026-09-01T00:00:00Z", agentRuns: [] } as unknown as RelaySession;
}

const launch = { id: "p-launch", name: "Autumn launch" } as ProjectRecord;
const docs = { id: "p-docs", name: "Docs" } as ProjectRecord;
// A standalone chat, a task thread in the launch project (the ordinary rail
// shows it), and the launch project's room thread (left to Projects).
const chat = session("s-chat", "Lunch plans");
const taskThread = session("s-task", "Release notes", launch.id);
const room = session("s-room", "Launch room", launch.id);
const task = { id: "t", title: "Release notes", linkedSessionIds: ["s-task"] } as RelayTaskListItem;

function directory(threadProjectFilter: ThreadProjectFilter, threadQuery = "") {
  return renderHook(() => useThreadDirectory({
    route: "main",
    myThreads: [chat, taskThread, room],
    projects: [launch, docs],
    routedProjectId: null,
    threadQuery,
    threadProjectFilter,
    tasks: [task],
    visibleNodes: [],
    runtimeNodes: [],
    logicalAgents: [],
  })).result.current;
}

const ids = (result: ReturnType<typeof directory>) => result.directoryThreads.map((item) => item.session.id).sort();

it("leaves the ordinary rail alone when no project is chosen", () => {
  const result = directory("all");
  expect(ids(result)).toEqual(["s-chat"]);
  expect(result.projectFilterOptions.map((option) => option.name)).toEqual(["Autumn launch", "Docs"]);
});

it("shows every thread of the chosen project, its room included", () => {
  expect(ids(directory(threadProjectFilterFor(launch.id)))).toEqual(["s-room", "s-task"]);
});

it("keeps only threads outside any project for No project", () => {
  expect(ids(directory("none"))).toEqual(["s-chat"]);
});

it("combines the project filter with the search", () => {
  expect(ids(directory(threadProjectFilterFor(launch.id), "room"))).toEqual(["s-room"]);
});

it("falls back to every thread when the chosen project no longer exists", () => {
  const result = directory(threadProjectFilterFor("p-gone"));
  expect(result.projectFilter).toBe("all");
  expect(ids(result)).toEqual(["s-chat"]);
});
