import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { GitHubConnectionPanel } from "../src/components/settings/GitHubConnectionPanel";

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GitHubConnectionPanel accountId="a1" /></QueryClientProvider>);
}

it("shows administrator setup guidance when GitHub is not configured", async () => {
  vi.spyOn(api, "getGitHubConnection").mockResolvedValue({ configured: false, connected: false, login: null, manageUrl: null });
  show();
  expect(await screen.findByText("github_connection.not_configured")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "github_connection.connect" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("disconnects the current account and updates both connection surfaces", async () => {
  vi.spyOn(api, "getGitHubConnection").mockResolvedValueOnce({ configured: true, connected: true, login: "octocat", manageUrl: "https://github.com/settings/installations" })
    .mockResolvedValue({ configured: true, connected: false, login: null, manageUrl: null });
  const disconnect = vi.spyOn(api, "disconnectGitHub").mockResolvedValue({ connected: false });
  show();
  expect(await screen.findByText("@octocat")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "github_connection.disconnect" }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "github_connection.connect" })).toBeTruthy();
});
