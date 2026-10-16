import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResetPasswordScreen } from "../src/components/password-reset/ResetPasswordScreen";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => window.history.replaceState(null, "", "/"));

it.each([500, 429, "network"])("retries a %s lookup using the token after clearing the fragment", async (failure) => {
  window.history.replaceState(null, "", "/reset-password#token=tok_live");
  const fetch = vi.fn()
    .mockImplementationOnce(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ detail: "Try again later" }), { status: failure });
    })
    .mockResolvedValueOnce(new Response(JSON.stringify({ reset: { username: "ada", expiresAt: "2026-10-22T00:00:00Z" } })));
  vi.stubGlobal("fetch", fetch);
  render(<ResetPasswordScreen />, { wrapper });
  expect(window.location.hash).toBe("");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "password_reset.retry_lookup" }));
  expect(await screen.findByDisplayValue("ada")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).not.toContain("tok_live");
    expect(JSON.parse(init.body)).toEqual({ token: "tok_live" });
  }
});

it("shows a dead link without offering lookup retry", async () => {
  window.history.replaceState(null, "", "/reset-password#token=tok_dead");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  render(<ResetPasswordScreen />, { wrapper });
  await screen.findByRole("heading", { name: "password_reset.dead_title" });
  expect(screen.queryByRole("button", { name: "password_reset.retry_lookup" })).toBeNull();
});
