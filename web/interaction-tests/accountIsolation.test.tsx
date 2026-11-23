import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";

const state = vi.hoisted(() => ({
  alice: { id: "account-alice", userId: "alice", username: "alice", role: "user" },
  bob: { id: "account-bob", userId: "bob", username: "bob", role: "user" },
  oldClient: null as QueryClient | null,
  preferences: { invalidate: vi.fn(), adopt: vi.fn(), setTheme: vi.fn() },
}));

vi.mock("../src/i18n/app", () => ({}));
vi.mock("../src/hooks/useUserPreferences", () => ({ useUserPreferences: () => state.preferences }));
vi.mock("../src/hooks/useClientMounted", () => ({ useClientMounted: () => true }));
vi.mock("../src/hooks/useLocationPathname", () => ({ useLocationPathname: () => "/tasks" }));
vi.mock("../src/hooks/useAuthRedirect", () => ({ useAuthRedirect: () => undefined }));
vi.mock("../src/components/BuildUpdateNotice", () => ({ BuildUpdateNotice: () => null }));
vi.mock("../src/components/LoginScreen", () => ({
  LoginScreen: ({ onAuthenticated }: any) => <button onClick={() => onAuthenticated(state.bob)}>Sign in as Bob</button>,
}));
vi.mock("../src/api", () => ({
  getMe: vi.fn(async () => ({ authenticated: true, user: state.alice, capabilities: { automationTriggers: false } })),
  RelayApiError: class extends Error {},
}));
vi.mock("../src/AuthenticatedApp", () => ({
  AuthenticatedApp: ({ user, setUser }: any) => {
    const client = useQueryClient();
    if (user.username === "alice") state.oldClient = client;
    const query = useQuery({
      queryKey: ["task-record", "private-task"],
      queryFn: () => user.username === "alice"
        ? Promise.resolve("Alice private task")
        : new Promise<string>(() => undefined),
      staleTime: Infinity,
    });
    return <>
      <div>{user.username}</div><div>{query.data}</div>
      <button onClick={() => setUser(null)}>Sign out</button>
    </>;
  },
}));

beforeEach(() => { state.oldClient = null; window.history.replaceState(null, "", "/tasks"); });

async function switchAccounts() {
  const root = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.setQueryData(["auth", "me"], state.alice);
  const view = render(<QueryClientProvider client={root}><App /></QueryClientProvider>);
  await screen.findByText("Alice private task");
  return { root, view, switchToBob: async () => {
    fireEvent.click(screen.getByText("Sign out"));
    fireEvent.click(await screen.findByText("Sign in as Bob"));
    await screen.findByText("bob");
  } };
}

it("never shows a previous account's cached task to the next account", async () => {
  const { root, view, switchToBob } = await switchAccounts();
  await switchToBob();
  expect(screen.queryByText("Alice private task")).toBeNull();
  view.unmount(); root.clear();
});

it("isolates a late write from the previous account's mutation", async () => {
  const { root, view, switchToBob } = await switchAccounts();
  const oldClient = state.oldClient!;
  await switchToBob();
  await act(async () => {
    oldClient.setQueryData(["task-record", "private-task"], "Alice late private data");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText("Alice late private data")).toBeNull();
  view.unmount(); root.clear();
});
