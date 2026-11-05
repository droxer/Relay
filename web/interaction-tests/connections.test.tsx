import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ConnectionsSection } from "../src/components/settings/ConnectionsSection";
import { ConnectionGrantField } from "../src/components/connections/ConnectionGrantField";

vi.mock("../src/api-client/connections", () => ({
  listConnections: vi.fn(async () => ({ connections: [{ id: "github-1", provider: "github", identity: "octocat", label: "Personal", status: "connected", actions: ["github.list_issues"] }] })),
  listConnectionProviders: vi.fn(async () => ({ providers: [{ id: "github", name: "GitHub", configured: true, actions: ["github.list_issues"] }, { id: "slack", name: "Slack", configured: false, actions: [] }] })),
  connectionResources: vi.fn(async () => ({ resources: [{ id: "octo/hello", name: "octo/hello" }], nextCursor: null })),
  connectionUsage: vi.fn(async () => ({ usage: [] })),
  getConnectionGrants: vi.fn(async () => ({ grants: [], readOnly: false })),
  disconnectConnection: vi.fn(async () => ({ disconnected: true })),
  startConnection: vi.fn(async () => ({ url: "https://github.com/authorize" })),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

it("shows the real connected identity and explains unavailable providers", async () => {
  render(<ConnectionsSection />, { wrapper });
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(screen.getByText("Slack")).toBeTruthy();
  expect(screen.getByText("connections.not_configured")).toBeTruthy();
  expect(screen.getByRole("button", { name: "connections.disconnect" })).toBeTruthy();
});

it("selects explicit resources and read actions for a work draft", async () => {
  const onChange = vi.fn();
  const view = render(<ConnectionGrantField value={[]} onChange={onChange} />, { wrapper });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Personal/ }));
  expect(onChange).toHaveBeenCalledWith([{ connectionId: "github-1", resources: [], actions: ["github.list_issues"] }]);
  view.rerender(<ConnectionGrantField value={[{ connectionId: "github-1", resources: [], actions: ["github.list_issues"] }]} onChange={onChange} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "octo/hello" }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ connectionId: "github-1", resources: ["octo/hello"], actions: ["github.list_issues"] }]));
});
