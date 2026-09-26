import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SideNav } from "../src/components/SideNav";
import { parseProjectPageTab, PROJECT_PAGE_TABS } from "../src/lib/projectPage";
import { canonicalBrowserUrl } from "../src/lib/appRoute";

vi.unmock("@/components/ui/button");

it("keeps separate Projects and Tasks destinations and selects Projects on project routes", () => {
  render(<SideNav sidenavExpanded={false} setSidenavExpanded={vi.fn()} width={200}
    onResize={vi.fn()} onResizeActive={vi.fn()} route="projects" onNavigateRoute={vi.fn()}
    hrefForRoute={(route) => `/${route}`} isAdmin={false} onLogout={vi.fn()} onOpenCommandMenu={vi.fn()} />);
  expect(screen.getByRole("link", { name: "project.projects" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "nav.backlog" }).getAttribute("aria-current")).toBeNull();
});

it("redirects legacy project Activities tabs to tasks while preserving task details", () => {
  expect(PROJECT_PAGE_TABS).not.toContain("activities");
  // Without a task the retired tab falls back to the default (General); with
  // one it still lands on the tasks board so the record survives.
  expect(parseProjectPageTab("activities")).toBe("general");
  expect(canonicalBrowserUrl("/projects/p", "?tab=activities")).toBe("/projects/p");
  expect(canonicalBrowserUrl("/projects/p", "?tab=activities&task=t")).toBe("/projects/p?task=t");
  expect(canonicalBrowserUrl("/projects/p", "?task=t&recordTab=files")).toBe("/projects/p?task=t&recordTab=files");
});

it("preserves project scope and filters through task record navigation", () => {
  expect(canonicalBrowserUrl("/issues", "?project=p&q=ship")).toBe("/issues?project=p&q=ship");
  expect(canonicalBrowserUrl("/issues/t", "?project=p&q=ship&tab=files")).toBe("/issues/t?tab=files&project=p&q=ship");
});
