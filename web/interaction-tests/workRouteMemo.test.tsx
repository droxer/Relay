import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkRoutePage } from "../src/components/WorkRoutePage";
import { TasksWorkspace } from "../src/components/TasksWorkspace";
import { IssuesPage } from "../src/components/IssuesPage";
import { AgentsPage } from "../src/components/AgentsPage";
import { AdminPage } from "../src/components/AdminPage";
import type { CurrentUser } from "../src/types";

const MEMO = Symbol.for("react.memo");

// The shell re-renders on every streamed frame of a run; a work page that is
// not memoized would re-render with it although it never shows that run.
it("memoizes the work route page and the pages it mounts", () => {
  for (const page of [WorkRoutePage, TasksWorkspace, IssuesPage, AgentsPage, AdminPage]) {
    expect((page as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO);
  }
});

it("does not re-render the work route page for an identical frame", () => {
  const onGoHome = vi.fn();
  const user = { userId: "u1", role: "member" } as unknown as CurrentUser;
  const props = {
    route: "backlog", notFound: true, user, projects: [], projectsStatus: "ready", tasks: [], visibleNodes: [], runtimeNodes: [],
    isRefreshing: false, onRefresh: vi.fn(), onOpenThread: vi.fn(), onGoHome, adminSection: "dashboard", onSelectAdminSection: vi.fn(),
    recordTaskId: null, recordRunId: null, onOpenTaskRecord: vi.fn(), onOpenRoutineRecord: vi.fn(), teamWorkspaceId: null,
    onSelectTeam: vi.fn(), detailAgent: null, onOpenAgent: vi.fn(), settingsSection: "general", onSelectSettingsSection: vi.fn(),
    theme: "light", onThemeChange: vi.fn(), language: "en", onLanguageChange: vi.fn(),
  } as unknown as Parameters<typeof WorkRoutePage>[0];
  const renders: number[] = [];
  const Probe = () => { renders.push(1); return null; };
  const view = render(<WorkRoutePage {...props} />);
  expect(view.container.querySelector("#route-not-found")).toBeTruthy();
  // Same props, new parent render: the memo must hold.
  const before = view.container.innerHTML;
  view.rerender(<><WorkRoutePage {...props} /><Probe /></>);
  expect(view.container.innerHTML).toBe(before);
  expect(renders).toHaveLength(1);
});
