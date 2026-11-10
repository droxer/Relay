import { act, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import hljs from "highlight.js/lib/core";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { RecordRuns } from "../src/components/task-record/RecordRuns";
import { RecordArtifacts } from "../src/components/task-record/RecordArtifacts";
import { highlightLiveToHtml, highlightToHtml } from "../src/lib/syntax";
import { updateTask, listTaskRuns, listTaskArtifacts } from "../src/api";
import type { RelayTask } from "../src/types";

vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), updateTask: vi.fn(), listTaskRuns: vi.fn(), listTaskArtifacts: vi.fn() }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));
vi.mock("../src/components/task-record/RecordWorkspace", () => ({ RecordWorkspace: () => null }));
vi.mock("../src/components/task-record/RecordArtifactPreview", () => ({ RecordArtifactPreview: () => null }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
const task = (id: string) => ({ id, priority: "normal", status: "backlog", updatedAt: "2026-11-10", eventCount: 0, events: [], activity: [] });
it.each(["a", "b"])("keeps a newer successful edit on task %s when an earlier edit fails", async (secondId) => {
  const { client, wrapper } = setup();
  client.setQueryData(["relay", "tasks"], [task("a"), task("b")]);
  let rejectFirst!: (error: Error) => void;
  vi.mocked(updateTask).mockReset()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
    .mockResolvedValueOnce({ ...task(secondId), priority: "low", updatedAt: "2026-11-11" } as RelayTask);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const view = renderHook(() => useRelayMutations(), { wrapper });
  let first!: Promise<unknown>;
  await act(async () => { first = view.result.current.updateTaskMutation.mutateAsync({ taskId: "a", input: { priority: "high" } }).catch(() => {}); });
  await act(async () => { await view.result.current.updateTaskMutation.mutateAsync({ taskId: secondId, input: { priority: "low" } }); });
  await act(async () => { rejectFirst(new Error("failed")); await first; });
  const rows = client.getQueryData<ReturnType<typeof task>[]>(["relay", "tasks"])!;
  expect(rows.find(row => row.id === secondId)?.priority).toBe("low");
  if (secondId !== "a") expect(rows.find(row => row.id === "a")?.priority).toBe("normal");
  view.unmount(); client.clear();
});
it.each([{ runs: [] }, { runs: [{ taskId: "old", status: "done", createdAt: "2026-11-01", artifactCount: 0 }] }])("discovers newly scheduled runs after a settled ledger: %j", async ({ runs }) => {
  vi.useFakeTimers();
  const { client, wrapper } = setup();
  vi.mocked(listTaskRuns).mockReset().mockResolvedValue({ runs } as never);
  const view = render(<RecordRuns taskId="routine" hrefForRun={id => id} onOpenRun={() => {}} />, { wrapper });
  await act(async () => {});
  vi.mocked(listTaskRuns).mockResolvedValue({ runs: [{ taskId: "new", status: "running", createdAt: "2026-11-10", artifactCount: 0 }] } as never);
  await act(() => vi.advanceTimersByTimeAsync(30_500));
  expect(client.getQueryData<{ runs: {taskId:string}[] }>(["task-runs", "routine", 25])?.runs[0]?.taskId).toBe("new");
  view.unmount(); client.clear();
});
it("refreshes artifacts after a task revision changes, without remounting", async () => {
  const { client, wrapper } = setup();
  vi.mocked(listTaskArtifacts).mockReset().mockResolvedValue({ artifacts: [] } as never);
  const view = render(<RecordArtifacts taskId="t" revision="running:1" />, { wrapper });
  await act(async () => {});
  vi.mocked(listTaskArtifacts).mockResolvedValue({ artifacts: [{ id: "new", title: "result.md", kind: "workspace_file", sessionId: "s", createdAt: "2026-11-10", bytes: 10 }] } as never);
  await act(async () => { view.rerender(<RecordArtifacts taskId="t" revision="done:2" />); });
  expect(await view.findByRole("button", { name: /result.md/ })).toBeTruthy();
  view.unmount(); client.clear();
});
it("bounds highlighting work for a growing live fence and highlights its final text", () => {
  const highlight = vi.spyOn(hljs, "highlight");
  let code = "";
  for (let i = 0; i < 400; i++) {
    code += `const secondReviewItem${i} = ${i};\n`;
    highlightLiveToHtml(code, "javascript");
  }
  const processed = highlight.mock.calls.reduce((count, [text]) => count + String(text).length, 0);
  expect(processed).toBeLessThan(100_000);
  const { settled, tail } = highlightLiveToHtml(code + "<script>", "javascript");
  expect(settled).not.toContain("<script>");
  expect(tail).toBe(code + "<script>");
  expect(highlightToHtml(code, "javascript")).toContain("hljs-keyword");
});
