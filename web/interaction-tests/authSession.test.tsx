import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

import * as api from "../src/api";
import { RelayApiError } from "../src/api";
import { useAuthSession } from "../src/hooks/useAuthSession";
import type { CurrentUser } from "../src/types";

const ADMIN = { id: "u1", username: "admin", role: "admin", employeeId: "admin" } as CurrentUser;

function wrapper() {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

it("treats a 401 from /auth/me as signed out", async () => {
  vi.spyOn(api, "getMe").mockRejectedValue(new RelayApiError("not signed in", 401));

  const { result } = renderHook(() => useAuthSession(), { wrapper: wrapper() });

  await waitFor(() => expect(result.current.status).toBe("anonymous"));
  expect(result.current.authChecked).toBe(true);
  expect(result.current.user).toBeNull();
});

it("keeps retrying, without signing out, while the backend is unreachable", async () => {
  const getMe = vi.spyOn(api, "getMe")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ authenticated: true, user: ADMIN });

  const { result } = renderHook(() => useAuthSession(), { wrapper: wrapper() });

  await waitFor(() => expect(result.current.status).toBe("unreachable"));
  expect(result.current.authChecked).toBe(false);

  await waitFor(() => expect(result.current.status).toBe("authenticated"), { timeout: 3_000 });
  expect(result.current.user).toEqual(ADMIN);
  expect(getMe).toHaveBeenCalledTimes(2);
});

it("lets login and logout replace the probed user", async () => {
  vi.spyOn(api, "getMe").mockRejectedValue(new RelayApiError("not signed in", 401));
  const { result } = renderHook(() => useAuthSession(), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.status).toBe("anonymous"));

  act(() => result.current.setUser(ADMIN));
  await waitFor(() => expect(result.current.status).toBe("authenticated"));

  act(() => result.current.setUser(null));
  await waitFor(() => expect(result.current.status).toBe("anonymous"));
});

it("does not let a pending probe overwrite a login", async () => {
  let resolve!: (value: { authenticated: boolean }) => void;
  vi.spyOn(api, "getMe").mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { result } = renderHook(() => useAuthSession(), { wrapper: wrapper() });
  act(() => result.current.setUser(ADMIN));
  await waitFor(() => expect(result.current.user).toEqual(ADMIN));
  await act(async () => { resolve({ authenticated: false }); });
  await waitFor(() => expect(result.current.status).toBe("authenticated"));
  expect(result.current.user).toEqual(ADMIN);
});
