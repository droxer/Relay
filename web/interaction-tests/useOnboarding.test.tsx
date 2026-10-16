import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboarding } from "../src/hooks/useOnboarding";
import { updateUserPreferences } from "../src/api";
import type { CurrentUser, DaemonNodeMonitorRecord, OnboardingPrefs, RelaySession, UserAgent } from "../src/types";

vi.mock("../src/api", () => ({ updateUserPreferences: vi.fn() }));
const reportMutationError = vi.hoisted(() => vi.fn());
vi.mock("../src/hooks/useMutationError", () => ({
  useMutationError: () => ({ reportMutationError }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const account = (onboarding: OnboardingPrefs = { introSeenAt: "seen" }) =>
  ({ id: "account-1", userId: "user-1", onboarding }) as CurrentUser;

function setup(user = account(), data = {
  nodes: [] as DaemonNodeMonitorRecord[], agents: [] as UserAgent[], threads: [] as RelaySession[],
}) {
  return renderHook(() => {
    const [current, setUser] = useState(user);
    return { controls: useOnboarding({ user: current, setUser, ...data }), user: current };
  });
}

beforeEach(() => { vi.mocked(updateUserPreferences).mockReset(); reportMutationError.mockClear(); });

describe("onboarding preference saves", () => {
  it("serializes rapid card closes and keeps newer choices visible while saving", async () => {
    const first = deferred<{ user: CurrentUser }>();
    const second = deferred<{ user: CurrentUser }>();
    vi.mocked(updateUserPreferences).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = setup();
    act(() => { result.current.controls.closeCard("tasks"); result.current.controls.closeCard("projects"); });
    await waitFor(() => expect(updateUserPreferences).toHaveBeenCalledTimes(1));
    expect(result.current.controls.progress.openCards).toEqual(["teams", "automations"]);
    await act(async () => first.resolve({ user: account({ introSeenAt: "seen", closedCards: ["tasks"] }) }));
    await waitFor(() => expect(updateUserPreferences).toHaveBeenCalledTimes(2));
    expect(result.current.controls.progress.openCards).toEqual(["teams", "automations"]);
    expect(updateUserPreferences).toHaveBeenLastCalledWith({ onboarding: { closedCards: ["tasks", "projects"] } });
    await act(async () => second.resolve({ user: account({ introSeenAt: "seen", closedCards: ["tasks", "projects"] }) }));
    expect(result.current.user.onboarding?.closedCards).toEqual(["tasks", "projects"]);
  });

  it("continues the queue after a failed save and rolls back failed choices", async () => {
    const first = deferred<{ user: CurrentUser }>();
    const second = deferred<{ user: CurrentUser }>();
    vi.mocked(updateUserPreferences).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = setup();
    act(() => result.current.controls.start());
    act(() => result.current.controls.dismiss());
    await act(async () => first.reject(new Error("offline")));
    await waitFor(() => expect(updateUserPreferences).toHaveBeenCalledTimes(2));
    expect(result.current.controls.progress.visible).toBe(false);
    await act(async () => second.reject(new Error("offline")));
    expect(result.current.controls.progress.visible).toBe(true);
    expect(reportMutationError).toHaveBeenCalledTimes(2);
  });

  it("explicitly reopens an account that never saw the intro", async () => {
    vi.mocked(updateUserPreferences).mockResolvedValue({ user: account({ introSeenAt: "seen" }) });
    const { result } = setup(account({}), {
      nodes: [{ id: "node-1", userId: "user-1", online: true, stale: false, agents: { claude: "ready" } } as DaemonNodeMonitorRecord],
      agents: [{ id: "agent-1", executorKind: "claude", availability: "ready", enabled: true,
        placements: [{ daemonNodeId: "node-1", desiredState: "active" }] } as UserAgent],
      threads: [{ status: "completed", agentRuns: [{ status: "completed" }] } as RelaySession],
    });
    expect(result.current.controls.progress.visible).toBe(false);
    act(() => result.current.controls.reopen());
    expect(result.current.controls.progress.visible).toBe(true);
    await waitFor(() => expect(updateUserPreferences).toHaveBeenCalledWith({
      onboarding: { introSeen: true, dismissed: false, closedCards: [] },
    }));
    await waitFor(() => expect(result.current.user.onboarding?.introSeenAt).toBeTruthy());
    expect(result.current.controls.progress.visible).toBe(true);
  });
});
