import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { WaitlistScreen } from "../src/components/waitlist/WaitlistScreen";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Answers /auth/status as "on" and the join POST with `join`. */
function stubFetch(join: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/auth/status")) return new Response(JSON.stringify({ requiresBootstrap: false, waitlistEnabled: true }));
    return join();
  }));
  return calls;
}

function submitWith(email: string, honeypot = "") {
  fireEvent.change(document.querySelector('[name="email"]')!, { target: { value: email } });
  fireEvent.change(document.querySelector('[name="website"]')!, { target: { value: honeypot } });
  fireEvent.submit(document.querySelector("form")!);
}

it.each([
  ["a body", () => new Response(JSON.stringify({ ok: true }), { status: 202 })],
  ["no body", () => new Response(null, { status: 202 })],
])("replaces the form with the one confirmation for any 202 (%s)", async (_label, join) => {
  stubFetch(join);
  render(<WaitlistScreen />, { wrapper });
  submitWith("ada@example.com");
  expect(await screen.findByText("waitlist.confirm_body")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "waitlist.confirm_title" })).toBeTruthy();
  expect(document.querySelector("form")).toBeNull();
});

it("sends the honeypot with whatever it holds, and the form's context", async () => {
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 202 }));
  render(<WaitlistScreen />, { wrapper });
  const honeypot = document.querySelector<HTMLInputElement>('[name="website"]')!;
  expect(honeypot.tabIndex).toBe(-1);
  expect(honeypot.getAttribute("aria-hidden")).toBe("true");
  expect(honeypot.getAttribute("autocomplete")).toBe("off");
  submitWith("ada@example.com", "https://spam.example");
  await screen.findByText("waitlist.confirm_body");
  const post = calls.find((call) => call.init?.method === "POST")!;
  expect(post.url).toMatch(/\/api\/v1\/waitlist$/);
  expect(JSON.parse(String(post.init?.body))).toMatchObject({
    email: "ada@example.com",
    website: "https://spam.example",
    locale: "en",
  });
});

it("says a rate limit in its own words and keeps the form", async () => {
  stubFetch(() => new Response(JSON.stringify({ detail: "Too many requests" }), { status: 429, headers: { "Retry-After": "60" } }));
  render(<WaitlistScreen />, { wrapper });
  submitWith("ada@example.com");
  expect((await screen.findByRole("alert")).textContent).toBe("waitlist.error_rate_limited");
  expect(document.querySelector("form")).not.toBeNull();
});

it("refuses a malformed email without a request", async () => {
  const calls = stubFetch(() => new Response(null, { status: 202 }));
  render(<WaitlistScreen />, { wrapper });
  submitWith("not-an-email");
  expect(await screen.findByText("waitlist.problem_invalid")).toBeTruthy();
  await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(false));
});
