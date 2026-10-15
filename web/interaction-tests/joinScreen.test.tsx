import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { JoinScreen } from "../src/components/waitlist/JoinScreen";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const INVITE = { email: "ada@example.com", name: "Ada", suggestedHandle: "Ada", expiresAt: "2026-10-22T00:00:00Z" };

function stubFetch(routes: { lookup: () => Response; accept?: () => Response }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/accept")) return routes.accept?.() ?? new Response(null, { status: 500 });
    return routes.lookup();
  }));
  return calls;
}

afterEach(() => window.history.replaceState(null, "", "/"));

it("explains a missing token and points back to the waitlist", () => {
  window.history.replaceState(null, "", "/join");
  stubFetch({ lookup: () => new Response(null, { status: 500 }) });
  render(<JoinScreen onAuthenticated={vi.fn()} />, { wrapper });
  expect(screen.getByRole("heading", { name: "waitlist.join_dead_title" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "waitlist.request_access" }).getAttribute("href")).toBe("/waitlist");
});

it("reads the token once, strips it from the URL, and treats a 404 as a dead invite", async () => {
  window.history.replaceState(null, "", "/join#token=tok_dead");
  const calls = stubFetch({ lookup: () => new Response(JSON.stringify({ detail: "This invite link is no longer valid." }), { status: 404 }) });
  render(<JoinScreen onAuthenticated={vi.fn()} />, { wrapper });
  expect(window.location.hash).toBe("");
  expect(window.location.pathname).toBe("/join");
  expect(await screen.findByRole("heading", { name: "waitlist.join_dead_title" })).toBeTruthy();
  // The token rides the body, never the path, so no access log keeps it.
  expect(calls[0].url).toMatch(/\/api\/v1\/waitlist\/invites\/lookup$/);
  expect(calls[0].url).not.toContain("tok_dead");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ token: "tok_dead" });
});

it("prefills a live invite and shows the server's 409 detail", async () => {
  window.history.replaceState(null, "", "/join#token=tok_live");
  const calls = stubFetch({
    lookup: () => new Response(JSON.stringify({ invite: INVITE })),
    accept: () => new Response(JSON.stringify({ detail: "That handle is already taken." }), { status: 409 }),
  });
  const onAuthenticated = vi.fn();
  render(<JoinScreen onAuthenticated={onAuthenticated} />, { wrapper });
  const email = await screen.findByDisplayValue("ada@example.com");
  expect(email.hasAttribute("readonly")).toBe(true);
  const handle = document.querySelector<HTMLInputElement>('[name="handle"]')!;
  expect(handle.value).toBe("ada");
  fireEvent.change(handle, { target: { value: "  @Ada.Lovelace" } });
  expect(handle.value).toBe("ada.lovelace");
  fireEvent.change(document.querySelector('[name="password"]')!, { target: { value: "correct horse battery" } });
  fireEvent.submit(document.querySelector("form")!);
  expect((await screen.findByRole("alert")).textContent).toBe("That handle is already taken.");
  const accept = calls.find((call) => call.url.endsWith("/accept"))!;
  expect(JSON.parse(String(accept.init?.body))).toEqual({
    token: "tok_live",
    handle: "ada.lovelace",
    password: "correct horse battery",
  });
  expect(onAuthenticated).not.toHaveBeenCalled();
});

it("hands a redeemed invite off exactly like a sign-in", async () => {
  window.history.replaceState(null, "", "/join#token=tok_live");
  const user = { id: "u1", username: "ada", role: "user" };
  stubFetch({
    lookup: () => new Response(JSON.stringify({ invite: INVITE })),
    accept: () => new Response(JSON.stringify({ user })),
  });
  const onAuthenticated = vi.fn();
  render(<JoinScreen onAuthenticated={onAuthenticated} />, { wrapper });
  await screen.findByDisplayValue("ada@example.com");
  fireEvent.change(document.querySelector('[name="password"]')!, { target: { value: "correct horse battery" } });
  fireEvent.submit(document.querySelector("form")!);
  await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(user));
});

it("refuses a password built from the invitee's own name before asking the server", async () => {
  window.history.replaceState(null, "", "/join#token=tok_live");
  const calls = stubFetch({ lookup: () => new Response(JSON.stringify({ invite: INVITE })) });
  render(<JoinScreen onAuthenticated={vi.fn()} />, { wrapper });
  await screen.findByDisplayValue("ada@example.com");
  fireEvent.change(document.querySelector('[name="handle"]')!, { target: { value: "lovelace" } });
  fireEvent.change(document.querySelector('[name="password"]')!, { target: { value: "lovelace-rules-99" } });
  fireEvent.submit(document.querySelector("form")!);
  expect(await screen.findByText("waitlist.password_problem_identifier")).toBeTruthy();
  expect(calls.some((call) => call.url.endsWith("/accept"))).toBe(false);
});
