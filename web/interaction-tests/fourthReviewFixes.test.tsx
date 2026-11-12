import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { Composer } from "../src/components/composer/Composer";
import { MAX_QUEUED_MESSAGES } from "../src/lib/threadQueue";
import { RecordResultLine } from "../src/components/task-record/RecordResultLine";
import { useAuthSession } from "../src/hooks/useAuthSession";
import { apiJson } from "../src/api-client/client";
import { getMe, listTaskRuns, listTasks, readArtifactText } from "../src/api";
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getMe: vi.fn(), listTaskRuns: vi.fn() }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
it.each([0, 20])("only clears a draft that the queue accepts (existing: %s)", async (count) => {
  const queue = Array.from({ length: count }, (_, i) => `queued ${i}`);
  const enqueue = vi.fn(async (text: string) => {
    if (queue.length >= MAX_QUEUED_MESSAGES) return false;
    queue.push(text);
    return true;
  });
  const view = render(<Composer logicalAgents={[]} activeLogicalAgentId={null} onLogicalAgentPicked={vi.fn()} activeAgentDisplayName="Codex" selectedUser="user" initializingThread={false} runtimeNodes={[]} runtimeNodeId="n" selectedRuntimeNode={null} activeRuntimeNode={null} onRuntimeNodeChange={vi.fn()} running onSend={vi.fn()} onCancelRun={vi.fn()} onQueue={enqueue} />);
  const field = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Keep this draft" } });
  fireEvent.submit(view.container.querySelector("form")!);
  await waitFor(() => expect(enqueue).toHaveBeenCalled());
  expect(field.value).toBe(count === 20 ? "Keep this draft" : "");
  expect(queue).toHaveLength(count === 20 ? 20 : 1);
  view.unmount();
});
it.each(["running:1", "done:2"])("reuses matching panel revisions and refreshes a changed revision after remount: %s", async (revision) => {
  const { client, wrapper } = setup();
  vi.mocked(listTaskRuns).mockReset().mockResolvedValue({ runs: [] } as never);
  const first = render(<RecordResultLine taskId="t" revision="running:1" />, { wrapper });
  await waitFor(() => expect(client.getQueryState(["task-runs", "t", 1])?.status).toBe("success"));
  first.unmount();
  vi.mocked(listTaskRuns).mockResolvedValue({ runs: [{ taskId: "t", status: "blocked", artifactCount: 1, failureMessage: "Final result" }] } as never);
  const second = render(<RecordResultLine taskId="t" revision={revision} />, { wrapper });
  if (revision === "done:2") expect(await second.findByText("Final result")).toBeTruthy();
  else { await act(async () => {}); expect(listTaskRuns).toHaveBeenCalledTimes(1); }
  second.unmount(); client.clear();
});
const user = { id: "u", username: "user" };
it.each(["json", "task-list", "artifact"])("revalidates rejected cookie sessions through %s requests", async (kind) => {
  const { client, wrapper } = setup();
  vi.mocked(getMe).mockReset().mockResolvedValue({ authenticated: true, user } as never);
  const view = renderHook(() => useAuthSession(), { wrapper });
  await waitFor(() => expect(view.result.current.status).toBe("authenticated"));
  vi.mocked(getMe).mockResolvedValue({ authenticated: false });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Authentication required" }), { status: 401 })));
  const request = kind === "json" ? apiJson("/tasks") : kind === "task-list" ? listTasks(undefined, {}) : readArtifactText("s", "a");
  await expect(request).rejects.toMatchObject({ status: 401 });
  await waitFor(() => expect(view.result.current.status).toBe("anonymous"));
  expect(getMe).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});
it.each([{ status: 401, token: "node-token" }, { status: 403 }, { status: 401, credentials: "omit" as const }])("does not treat unrelated API rejection as session expiry: %j", async (options) => {
  const { client, wrapper } = setup();
  vi.mocked(getMe).mockReset().mockResolvedValue({ authenticated: true, user } as never);
  const view = renderHook(() => useAuthSession(), { wrapper });
  await waitFor(() => expect(view.result.current.status).toBe("authenticated"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: options.status })));
  await expect(apiJson("/tasks", options)).rejects.toMatchObject({ status: options.status });
  await act(async () => {});
  expect(view.result.current.status).toBe("authenticated");
  expect(getMe).toHaveBeenCalledTimes(1);
  view.unmount(); client.clear();
});
it("coalesces concurrent rejections and retains a session the auth probe confirms", async () => {
  const { client, wrapper } = setup();
  vi.mocked(getMe).mockReset().mockResolvedValue({ authenticated: true, user } as never);
  const view = renderHook(() => [useAuthSession(), useAuthSession()], { wrapper });
  await waitFor(() => expect(view.result.current[0].status).toBe("authenticated"));
  let finish!: (value: never) => void;
  vi.mocked(getMe).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  await act(async () => { await Promise.allSettled([apiJson("/tasks"), apiJson("/projects")]); });
  expect(getMe).toHaveBeenCalledTimes(2);
  await act(async () => finish({ authenticated: true, user } as never));
  expect(view.result.current[0].status).toBe("authenticated");
  view.unmount(); client.clear();
});
