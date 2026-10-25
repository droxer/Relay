import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { RecordWorkspace } from "../src/components/task-record/RecordWorkspace";
import { listTaskWorkspaceFiles } from "../src/api";

vi.mock("../src/api", () => ({
  listTaskWorkspaceFiles: vi.fn(),
  readTaskWorkspaceFile: vi.fn(),
  taskWorkspaceStatus: vi.fn(async () => ({ waiting: false })),
}));

/** The daemon's listing for each folder; a folder left out does not exist. */
function workspaceWith(folders: Record<string, string[]>): void {
  vi.mocked(listTaskWorkspaceFiles).mockImplementation(async ({ path }: { path: string }) => {
    const names = folders[path];
    return {
      path,
      exists: names !== undefined,
      entries: (names ?? []).map((name) => ({
        name,
        path: path ? `${path}/${name}` : name,
        kind: "directory" as const,
        bytes: null,
        updatedAt: "2026-10-18T00:00:00Z",
      })),
    } as never;
  });
}

function renderWorkspace(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RecordWorkspace taskId="t1" /></QueryClientProvider>);
}

afterEach(() => vi.mocked(listTaskWorkspaceFiles).mockReset());

it("names a workspace that was never created, not an empty Artifacts tab", async () => {
  workspaceWith({});
  renderWorkspace();
  expect(await screen.findByText("backlog.workspace_not_created")).toBeTruthy();
  expect(screen.queryByText("workspace.files_unavailable")).toBeNull();
});

it("shows an empty Artifacts tab when the workspace exists without artifacts/", async () => {
  workspaceWith({ "": [".threads"] });
  renderWorkspace();
  expect(await screen.findByText("workspace.artifacts_empty")).toBeTruthy();
  expect(screen.queryByText("workspace.files_unavailable")).toBeNull();
  expect(screen.getByRole("button", { name: "workspace.tab_artifacts", pressed: true })).toBeTruthy();
});
