import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { RelayEntry } from "../src/components/RelayEntry";

vi.mock("../src/i18n", () => ({ default: { language: "en", changeLanguage: vi.fn(async () => undefined) } }));
vi.mock("../src/api", () => ({ getMe: vi.fn(), RelayApiError: class extends Error {} }));
// A chunk that fails to load, as after a deploy removed it.
vi.mock("../src/App", () => {
  throw new Error("chunk failed to load");
});

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p>boundary: {this.state.error.message}</p> : this.props.children;
  }
}

it("shows a failed app chunk to the error boundary instead of waiting forever", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/threads");
  render(
    <Boundary>
      <QueryClientProvider client={new QueryClient()}>
        <RelayEntry />
      </QueryClientProvider>
    </Boundary>,
  );
  // Vitest rewords a throwing mock factory's message; what matters is that the
  // failure reached the boundary and the gate did not stay up.
  expect(await screen.findByText(/^boundary:/)).toBeTruthy();
  expect(screen.queryByText("Checking sign-in…")).toBeNull();
  window.history.replaceState(null, "", "/");
});
