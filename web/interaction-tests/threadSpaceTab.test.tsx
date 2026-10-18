import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ThreadSpacePanel } from "../src/components/space/ThreadSpacePanel";
import { APP_NAVIGATION_EVENT } from "../src/lib/appRoute";

vi.mock("../src/components/space/ThreadSpaceFiles", () => ({
  ThreadSpaceFiles: () => <div data-testid="project-files" />,
  RefreshFilesButton: () => null,
  useRefreshProjectFiles: () => () => undefined,
}));

function panel(sessionId: string, projectId: string | null) {
  return (
    <ThreadSpacePanel
      sessionId={sessionId}
      projectId={projectId}
      items={[]}
      showProducer={false}
      selectedArtifactId={null}
      onSelectArtifact={() => {}}
      onClose={() => {}}
      width={480}
      onResize={() => {}}
      onResizeActive={() => {}}
    />
  );
}

function navigate(url: string) {
  window.history.pushState({}, "", url);
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
}

describe("thread space tab", () => {
  it("opens a project thread on its project and keeps a thread choice until the thread changes", () => {
    window.history.replaceState({}, "", "/threads/one?space=1");
    const { rerender } = render(panel("one", "p1"));
    expect(screen.getByTestId("project-files")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "space.tab_thread" }));
    expect(screen.queryByTestId("project-files")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("spaceTab")).toBeNull();
    rerender(panel("one", "p1"));
    expect(screen.queryByTestId("project-files")).toBeNull();

    act(() => navigate("/threads/two?space=1"));
    rerender(panel("two", "p1"));
    expect(screen.getByTestId("project-files")).toBeTruthy();
  });

  it("honours a linked project tab on arrival without rewriting the URL", () => {
    window.history.replaceState({}, "", "/threads/one?space=1&spaceTab=project");
    render(panel("one", "p1"));
    expect(screen.getByTestId("project-files")).toBeTruthy();
    expect(window.location.search).toBe("?space=1&spaceTab=project");

    fireEvent.click(screen.getByRole("tab", { name: "space.tab_thread" }));
    expect(screen.queryByTestId("project-files")).toBeNull();
    expect(window.location.search).toBe("?space=1");

    fireEvent.click(screen.getByRole("tab", { name: "space.tab_project" }));
    expect(screen.getByTestId("project-files")).toBeTruthy();
    expect(window.location.search).toBe("?space=1&spaceTab=project");
  });

  it("follows the default when a solo thread joins a project", () => {
    window.history.replaceState({}, "", "/threads/one?space=1");
    const { rerender } = render(panel("one", null));
    expect(screen.queryByTestId("project-files")).toBeNull();
    rerender(panel("one", "p1"));
    expect(screen.getByTestId("project-files")).toBeTruthy();
  });
});
