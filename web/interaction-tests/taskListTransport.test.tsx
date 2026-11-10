import { expect, it, vi } from "vitest";
import { listTasks, type TaskListCache } from "../src/api-client/tasks";
const task = { id: "one", title: "One", status: "done", createdAt: "2026-01-01", updatedAt: "2026-01-01", linkedSessionIds: [] };
it("reuses parsed task rows on 304 and replaces them after a change", async () => {
  const cache: TaskListCache = {};
  const unchanged = new Response(null, { status: 304 });
  const read = vi.spyOn(unchanged, "text");
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [task] }), { headers: { ETag: 'W/"first"' } }))
    .mockResolvedValueOnce(unchanged)
    .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [] }), { headers: { ETag: 'W/"second"' } }));
  vi.stubGlobal("fetch", fetcher);
  const first = await listTasks(undefined, cache);
  expect(await listTasks(undefined, cache)).toBe(first);
  expect(read).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: "no-store", headers: { "If-None-Match": 'W/"first"' } });
  expect((await listTasks(undefined, cache)).tasks).toEqual([]);
});
it("does not share task responses across personal caches", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tasks: [] }))));
  await listTasks(undefined, {});
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).not.toHaveProperty("If-None-Match");
});

it("keeps the last valid response when a request fails or returns malformed rows", async () => {
  const data = { tasks: [task] } as never;
  const cache: TaskListCache = { etag: 'W/"valid"', data };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Denied" }), { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [{}] }), { headers: { ETag: 'W/"invalid"' } })));
  await expect(listTasks(undefined, cache)).rejects.toMatchObject({ status: 403 });
  await expect(listTasks(undefined, cache)).rejects.toMatchObject({ code: "invalid_response_shape" });
  expect(cache).toEqual({ etag: 'W/"valid"', data });
});

it("does not retain a response after its personal-space request was aborted", async () => {
  const cache: TaskListCache = {};
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => {
    controller.abort();
    return new Response(JSON.stringify({ tasks: [task] }), { headers: { ETag: 'W/"late"' } });
  }));
  await listTasks(controller.signal, cache);
  expect(cache).toEqual({});
});
