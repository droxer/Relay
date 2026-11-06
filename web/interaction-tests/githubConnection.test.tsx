import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { GitHubConnectionPanel } from "../src/components/settings/GitHubConnectionPanel";

it("keeps public import anonymous without fetching credentials or offering authorization", () => {
  const status = vi.spyOn(api, "getGitHubConnection").mockResolvedValue({ configured: true, connected: false, login: null, manageUrl: null });
  const connect = vi.spyOn(api, "startGitHubConnection");
  render(<QueryClientProvider client={new QueryClient()}><GitHubConnectionPanel /></QueryClientProvider>);
  expect(screen.getByText("github_connection.public_repositories")).toBeTruthy();
  expect(screen.getByText("github_connection.public_only")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(status).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
