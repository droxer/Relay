import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useComposer } from "../src/hooks/useComposer";

beforeEach(() => sessionStorage.clear());

it("keeps separate thread and new-thread drafts and restores them after remount", () => {
  const hook = renderHook((key: string) => useComposer(key), { initialProps: "alice:thread-a" });
  act(() => hook.result.current.setComposerText("Detailed request"));
  hook.rerender("alice:new");
  expect(hook.result.current.composerText).toBe("");
  act(() => hook.result.current.setComposerText("New request"));
  hook.rerender("alice:thread-a");
  expect(hook.result.current.composerText).toBe("Detailed request");
  hook.unmount();
  const restored = renderHook(() => useComposer("alice:new"));
  expect(restored.result.current.composerText).toBe("New request");
});

it("isolates accounts and removes a cleared draft from storage", () => {
  const hook = renderHook((key: string) => useComposer(key), { initialProps: "alice:thread-a" });
  act(() => hook.result.current.setComposerText("Private request"));
  hook.rerender("bob:thread-a");
  expect(hook.result.current.composerText).toBe("");
  hook.rerender("alice:thread-a");
  act(() => hook.result.current.setComposerText(""));
  hook.unmount();
  expect(renderHook(() => useComposer("alice:thread-a")).result.current.composerText).toBe("");
  expect(sessionStorage.length).toBe(0);
});

it("accepts functional updates and still edits when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  const hook = renderHook(() => useComposer("alice:new"));
  act(() => hook.result.current.setComposerText("Hello"));
  act(() => hook.result.current.setComposerText((text) => `${text} again`));
  expect(hook.result.current.composerText).toBe("Hello again");
});
