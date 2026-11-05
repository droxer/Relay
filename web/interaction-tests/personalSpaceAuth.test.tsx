import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { PersonalSpaceProvider } from "../src/components/PersonalSpaceProvider";
import { useAuthSession } from "../src/hooks/useAuthSession";
import { useRelayStore } from "../src/lib/store";
import type { CurrentUser } from "../src/types";

it("shares authentication across personal caches without clearing selections or exposing private data", async () => {
  const user = { id: "account", userId: "alice", username: "Alice", role: "user" } as CurrentUser;
  const getMe = vi.spyOn(api, "getMe").mockResolvedValue({ authenticated: true, user });
  const authClient = new QueryClient();
  authClient.setQueryData(["auth", "me"], user);
  authClient.setQueryData(["relay", "sessions"], [{ id: "old-private-thread" }]);
  useRelayStore.setState({ selectedUser: "alice", selectedSessionId: "thread", activeSessionId: "thread" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={authClient}>
      <PersonalSpaceProvider>{children}</PersonalSpaceProvider>
    </QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => ({ auth: useAuthSession(), dataClient: useQueryClient() }), { wrapper });
  await waitFor(() => expect(result.current.auth.status).toBe("authenticated"));
  expect(getMe).not.toHaveBeenCalled();
  expect(useRelayStore.getState().selectedUser).toBe("alice");
  expect(useRelayStore.getState().selectedSessionId).toBe("thread");
  expect(result.current.dataClient).not.toBe(authClient);
  expect(result.current.dataClient.getQueryData(["relay", "sessions"])).toBeUndefined();
  const updated = { ...user, username: "Updated Alice" };
  act(() => result.current.auth.setUser(updated));
  expect(authClient.getQueryData(["auth", "me"])).toEqual(updated);
  unmount();
  authClient.clear();
});
