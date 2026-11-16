import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { fetchSessionSnapshot } from "../src/lib/sessionSnapshotQuery";
import { getSession } from "../src/api";
vi.mock("../src/api", () => ({ getSession: vi.fn() }));

it("deduplicates hydration and stream fallback per account without hiding later changes", async () => {
  const client = new QueryClient();
  const other = new QueryClient();
  let resolve!: (snapshot: never) => void;
  vi.mocked(getSession).mockReturnValue(new Promise(done => { resolve = done; }));
  const hydration = fetchSessionSnapshot(client, "thread");
  const fallback = fetchSessionSnapshot(client, "thread");
  expect(getSession).toHaveBeenCalledTimes(1);
  resolve({ id: "thread" } as never);
  expect(await hydration).toBe(await fallback);
  vi.mocked(getSession).mockResolvedValue({ id: "thread", title: "New" } as never);
  expect(await fetchSessionSnapshot(client, "thread")).toHaveProperty("title", "New");
  await fetchSessionSnapshot(other, "thread");
  expect(getSession).toHaveBeenCalledTimes(3);
  client.clear(); other.clear();
});
