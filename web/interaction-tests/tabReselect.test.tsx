import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SideNav } from "../src/components/SideNav";
import { isAtTabRoot, scrollPanesToTop } from "../src/lib/tabReselect";

vi.unmock("@/components/ui/button");

/** A pane the test scrolled: jsdom lays nothing out, so rendering and the
 *  scroll call are stubbed on the element itself. */
function scrolledPane(scrollTop: number, rendered = true) {
  const pane = document.createElement("div");
  Object.defineProperty(pane, "scrollTop", { value: scrollTop, configurable: true });
  pane.getClientRects = () => ({ length: rendered ? 1 : 0 }) as DOMRectList;
  pane.scrollTo = vi.fn() as typeof pane.scrollTo;
  return pane;
}

function renderNav(route: "backlog" | "projects", onNavigateRoute = vi.fn()) {
  const shell = document.createElement("div");
  shell.className = "messenger-shell";
  document.body.append(shell);
  const pane = scrolledPane(480);
  shell.append(pane);
  render(<SideNav sidenavExpanded={false} setSidenavExpanded={vi.fn()} width={200}
    onResize={vi.fn()} onResizeActive={vi.fn()} route={route} onNavigateRoute={onNavigateRoute}
    hrefForRoute={(next) => `/${next}`} isAdmin={false} onLogout={vi.fn()} onOpenCommandMenu={vi.fn()} />,
  { container: shell.appendChild(document.createElement("div")) });
  return { shell, pane, onNavigateRoute };
}

it("knows the root of a tab only by its exact path and query", () => {
  expect(isAtTabRoot("/backlog", { pathname: "/backlog", search: "" })).toBe(true);
  expect(isAtTabRoot("/backlog", { pathname: "/backlog/t1", search: "" })).toBe(false);
  expect(isAtTabRoot("/backlog", { pathname: "/backlog", search: "?q=x" })).toBe(false);
});

it("scrolls only rendered, scrolled panes outside the excluded tab bar", () => {
  const root = document.createElement("div");
  const bar = document.createElement("nav");
  const scrolled = scrolledPane(200);
  const atTop = scrolledPane(0);
  const hidden = scrolledPane(200, false);
  const inBar = scrolledPane(40);
  bar.append(inBar);
  root.append(scrolled, atTop, hidden, bar);

  expect(scrollPanesToTop(root, { exclude: bar, smooth: true })).toBe(1);
  expect(scrolled.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  for (const pane of [atTop, hidden, inBar]) expect(pane.scrollTo).not.toHaveBeenCalled();
});

it("scrolls the screen to its top when the current tab is tapped again at its root", () => {
  window.history.replaceState({}, "", "/backlog");
  const { pane, onNavigateRoute } = renderNav("backlog");

  fireEvent.click(screen.getByRole("link", { name: "nav.backlog" }));

  expect(onNavigateRoute).not.toHaveBeenCalled();
  expect(pane.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
});

it("pops a nested screen back to its tab root instead of scrolling it", () => {
  window.history.replaceState({}, "", "/projects/p1");
  const { pane, onNavigateRoute } = renderNav("projects");

  fireEvent.click(screen.getByRole("link", { name: "project.projects" }));

  expect(onNavigateRoute).toHaveBeenCalledWith("projects");
  expect(pane.scrollTo).not.toHaveBeenCalled();
});

it("switches tabs as before when another tab is tapped", () => {
  window.history.replaceState({}, "", "/backlog");
  const { pane, onNavigateRoute } = renderNav("backlog");

  fireEvent.click(screen.getByRole("link", { name: "project.projects" }));

  expect(onNavigateRoute).toHaveBeenCalledWith("projects");
  expect(pane.scrollTo).not.toHaveBeenCalled();
});
