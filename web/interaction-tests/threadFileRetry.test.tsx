import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { ProjectWorkspaceFiles } from "../src/components/ProjectWorkspaceFiles";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { ThreadSpaceFiles } from "../src/components/space/ThreadSpaceFiles";

const { listFiles, readFile } = vi.hoisted(() => ({ listFiles: vi.fn(), readFile: vi.fn() }));
vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listProjectWorkspaceFiles: listFiles,
  readProjectWorkspaceFile: readFile,
}));

beforeEach(() => {
  listFiles.mockReset();
  readFile.mockReset();
});

it.each([
  ["project workspace", <ProjectWorkspaceFiles projectId="p" />],
  ["thread panel", <ThreadSpaceFiles projectId="p" selectedPath="" onSelectPath={vi.fn()} onClose={vi.fn()} />],
])("waits for manual retry when the Computer is unavailable in the %s", async (_surface, browser) => {
  listFiles.mockRejectedValueOnce(new RelayApiError("placement-unavailable", 503))
    .mockResolvedValue({ entries: [], exists: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  render(<QueryClientProvider client={queryClient}>
    <DialogProvider>{browser}</DialogProvider>
  </QueryClientProvider>);
  const retry = await screen.findByRole("button", { name: "workspace.retry" });
  expect(listFiles).toHaveBeenCalledOnce();
  fireEvent.click(retry);
  await screen.findByText("workspace.no_files");
  expect(listFiles).toHaveBeenCalledTimes(2);
  queryClient.clear();
});

it("retries the selected file content without refreshing its directory", async () => {
  listFiles.mockResolvedValue({ entries: [], exists: true });
  readFile.mockRejectedValueOnce(new RelayApiError("placement-unavailable", 503))
    .mockResolvedValue({ content: "Recovered file", isBinary: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>
    <DialogProvider><ThreadSpaceFiles projectId="p" selectedPath="report.txt" onSelectPath={vi.fn()} onClose={vi.fn()} /></DialogProvider>
  </QueryClientProvider>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  await screen.findByText("Recovered file");
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(readFile.mock.calls[1][0]).toEqual({ projectId: "p", path: "report.txt" });
  expect(listFiles).toHaveBeenCalledOnce();
  queryClient.clear();
});
