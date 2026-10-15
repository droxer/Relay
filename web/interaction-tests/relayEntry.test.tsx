import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RelayEntry } from "../src/components/RelayEntry";
import { APP_NAVIGATION_EVENT } from "../src/lib/appRoute";
import { SIGNED_IN_HINT_KEY } from "../src/lib/appStorage";

const { getMe, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return { getMe: vi.fn(), ApiError };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", t: (key: string) => key, changeLanguage: vi.fn(async () => undefined) },
  }),
}));
vi.mock("../src/api", () => ({ getMe, RelayApiError: ApiError }));
vi.mock("../src/App", () => ({ App: () => <p>relay app</p> }));
vi.mock("../src/components/landing/LandingScreen", () => ({ LandingScreen: () => <p>landing page</p> }));

function renderEntry() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RelayEntry /></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  getMe.mockReset();
  getMe.mockRejectedValue(new ApiError("signed out", 401));
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

it("shows a first-time visitor the landing page without the app", async () => {
  renderEntry();
  expect(await screen.findByText("landing page")).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText("relay app")).toBeNull();
  expect(getMe).toHaveBeenCalled();
  expect(localStorage.getItem(SIGNED_IN_HINT_KEY)).toBeNull();
});

it("leaves the tab title to the landing page", async () => {
  document.title = "landing.page_title";
  renderEntry();
  expect(await screen.findByText("landing page")).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  expect(document.title).toBe("landing.page_title");
});

it("goes straight to the app for a browser that was signed in", async () => {
  localStorage.setItem(SIGNED_IN_HINT_KEY, "1");
  renderEntry();
  expect(await screen.findByText("relay app")).toBeTruthy();
  expect(screen.queryByText("landing page")).toBeNull();
});

it("serves the app on any other path", async () => {
  window.history.replaceState(null, "", "/threads");
  renderEntry();
  expect(await screen.findByText("relay app")).toBeTruthy();
});

it("hands over to the app when the visitor leaves the landing page", async () => {
  renderEntry();
  expect(await screen.findByText("landing page")).toBeTruthy();
  act(() => {
    window.history.pushState(null, "", "/login");
    window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
  });
  expect(await screen.findByText("relay app")).toBeTruthy();
});

it("hands over when the session turns out to be signed in, and remembers it", async () => {
  getMe.mockResolvedValue({ authenticated: true, user: { userId: "u-1", username: "ada" } });
  renderEntry();
  expect(await screen.findByText("relay app")).toBeTruthy();
  expect(localStorage.getItem(SIGNED_IN_HINT_KEY)).toBe("1");
});
