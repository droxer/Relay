import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useThreadNavigation } from "../src/hooks/useThreadNavigation";

it("starts a new thread without clearing the current thread's draft", () => {
  const clear = vi.fn();
  const syncThreadUrl = vi.fn();
  const { result } = renderHook(() => useThreadNavigation({
    route: "main", myThreads: [], tasks: [], tasksStatus: "ready",
    activeSession: undefined, composingNew: false, routedSessionId: null,
    routedProjectId: null, recordTaskId: null, threadComputers: [], assignableComputers: [],
    composerRef: { current: { clear, focus: vi.fn(), getText: () => "Keep my draft", setText: vi.fn(), send: vi.fn() } },
    pinTranscriptToBottom: vi.fn(), showThreadList: vi.fn(), syncThreadUrl,
    navigateToProject: vi.fn(),
  }));
  act(() => result.current.startNewThread());
  expect(clear).not.toHaveBeenCalled();
  expect(syncThreadUrl).toHaveBeenCalledWith(null, false, null);
});
