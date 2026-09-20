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
  expect(project.getAttribute("href")).toBe("/backlog?project=p");
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

it("keeps separate Projects and Tasks destinations and selects Projects on project routes", () => {
  render(<SideNav sidenavExpanded={false} setSidenavExpanded={vi.fn()} width={200}
    onResize={vi.fn()} onResizeActive={vi.fn()} route="projects" onNavigateRoute={vi.fn()}
    hrefForRoute={(route) => `/${route}`} isAdmin={false} onLogout={vi.fn()} onOpenCommandMenu={vi.fn()} />);
  expect(screen.getByRole("link", { name: "project.projects" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "nav.backlog" }).getAttribute("aria-current")).toBeNull();
});

it("redirects legacy project Activities tabs to tasks while preserving task details", () => {
  expect(PROJECT_PAGE_TABS).not.toContain("activities");
  expect(parseProjectPageTab("activities")).toBe("tasks");
  expect(canonicalBrowserUrl("/projects/p", "?tab=activities")).toBe("/projects/p");
  expect(canonicalBrowserUrl("/projects/p", "?task=t&recordTab=files")).toBe("/projects/p?task=t&recordTab=files");
});


it("groups task links below their project and highlights the selected task", () => {
  const open = vi.fn();
  render(<ProjectTaskNav projects={projects} projectId="p" taskId="1" onOpenTask={open}
    tasks={[
      { id: "1", title: "Write release notes", projectId: "p", status: "backlog" },
      { id: "2", title: "Answer customers", projectId: "q", status: "running" },
      { id: "3", title: "Deleted task", projectId: "p", status: "backlog", deletedAt: "today" },
      { id: "4", title: "Routine definition", projectId: "p", status: "backlog", isRoutine: true },
    ] as RelayTaskListItem[]} onSelect={vi.fn()} onCreate={vi.fn()} status="ready" onRetry={vi.fn()} />);
  const link = screen.getByRole("link", { name: /Write release notes/ });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.getAttribute("href")).toBe("/backlog/1?project=p");
  expect(link.closest("section")?.getAttribute("aria-label")).toBe("Launch");
  expect(screen.getByRole("link", { name: /Answer customers/ }).closest("section")?.getAttribute("aria-label")).toBe("Support");
  expect(screen.queryByRole("link", { name: /Deleted task|Routine definition/ })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: /Answer customers/ }));
  expect(open).toHaveBeenCalledWith("2", "q");
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  expect(screen.queryByRole("link", { name: /Write release notes/ })).toBeNull();
});

it("preserves project scope and filters through task record navigation", () => {
  expect(canonicalBrowserUrl("/backlog", "?project=p&q=ship")).toBe("/backlog?project=p&q=ship");
  expect(canonicalBrowserUrl("/backlog/t", "?project=p&q=ship&tab=files")).toBe("/backlog/t?tab=files&project=p&q=ship");
});
