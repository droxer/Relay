import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { ThreadSpaceFiles } from "../src/components/space/ThreadSpaceFiles";

const { listFiles, readFile } = vi.hoisted(() => ({ listFiles: vi.fn(), readFile: vi.fn() }));
vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listProjectWorkspaceFiles: listFiles,
  readProjectWorkspaceFile: readFile,
}));

it("retries the selected file content without refreshing its directory", async () => {
  listFiles.mockResolvedValue({ entries: [], exists: true });
  readFile.mockRejectedValueOnce(new Error("temporarily unavailable"))
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
