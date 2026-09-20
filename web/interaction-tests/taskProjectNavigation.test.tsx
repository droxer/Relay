import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectTaskNav } from "../src/components/ProjectTaskNav";
import { SideNav } from "../src/components/SideNav";
import { parseProjectPageTab, PROJECT_PAGE_TABS } from "../src/lib/projectPage";
import { canonicalBrowserUrl } from "../src/lib/appRoute";
import type { ProjectRecord, RelayTaskListItem } from "../src/types";

vi.unmock("@/components/ui/button");

const projects = [
  { id: "p", name: "Launch", enabled: true },
  { id: "q", name: "Support", enabled: true },
  { id: "a", name: "Archived", enabled: true, archivedAt: "today" },
] as ProjectRecord[];

it("lists projects with live open task counts and navigates without losing native links", () => {
  const select = vi.fn(); const create = vi.fn();
  render(<ProjectTaskNav projects={projects} projectId="p" tasks={[
    { id: "1", projectId: "p", status: "backlog" },
    { id: "2", projectId: "p", status: "done" },
    { id: "3", projectId: "p", status: "backlog", deletedAt: "today" },
    { id: "4", projectId: "p", status: "backlog", isRoutine: true },
  ] as RelayTaskListItem[]} onSelect={select} onCreate={create} status="ready" onRetry={vi.fn()} />);
  const project = screen.getByRole("link", { name: /Launch/ });
  expect(project.getAttribute("aria-current")).toBe("page");
  expect(project.textContent).toBe("Launch1");
  expect(project.getAttribute("href")).toBe("/projects/p");
  fireEvent.click(screen.getByRole("link", { name: /Support/ }));
  expect(select).toHaveBeenLastCalledWith("q");
  fireEvent.click(screen.getByRole("link", { name: /project.all_projects/ }));
  expect(select).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("link", { name: /Archived/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).toHaveBeenCalled();
});

it("keeps a selected archived project reachable and exposes mobile selection", () => {
  const select = vi.fn();
  render(<ProjectTaskNav projects={projects} projectId="a" tasks={[]} onSelect={select} onCreate={vi.fn()} status="ready" onRetry={vi.fn()} />);
  expect(screen.getByRole("link", { name: /Archived/ }).getAttribute("aria-current")).toBe("page");
  fireEvent.change(screen.getByRole("combobox", { name: "project.projects" }), { target: { value: "q" } });
  expect(select).toHaveBeenCalledWith("q");
});

it("reports failed project loading and allows retry", () => {
  const retry = vi.fn();
  render(<ProjectTaskNav projects={[]} projectId={null} tasks={[]} onSelect={vi.fn()} onCreate={vi.fn()} status="error" onRetry={retry} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.retry" }));
  expect(retry).toHaveBeenCalled();
});

it("has one Tasks destination selected on project routes", () => {
  render(<SideNav sidenavExpanded={false} setSidenavExpanded={vi.fn()} width={200}
    onResize={vi.fn()} onResizeActive={vi.fn()} route="projects" onNavigateRoute={vi.fn()}
    hrefForRoute={(route) => `/${route}`} isAdmin={false} onLogout={vi.fn()} onOpenCommandMenu={vi.fn()} />);
  expect(screen.queryByRole("link", { name: "project.projects" })).toBeNull();
  expect(screen.getByRole("link", { name: "nav.backlog" }).getAttribute("aria-current")).toBe("page");
});

it("redirects legacy project Activities tabs to tasks while preserving task details", () => {
  expect(PROJECT_PAGE_TABS).not.toContain("activities");
  expect(parseProjectPageTab("activities")).toBe("tasks");
  expect(canonicalBrowserUrl("/projects/p", "?tab=activities")).toBe("/projects/p");
  expect(canonicalBrowserUrl("/projects/p", "?task=t&recordTab=files")).toBe("/projects/p?task=t&recordTab=files");
});
