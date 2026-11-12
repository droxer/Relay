import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import * as connections from "../src/api-client/connections";
import * as api from "../src/api";
import { GitHubImportDrawer } from "../src/components/task-board/GitHubImportDrawer";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));

function setup() {
  vi.spyOn(connections, "listConnections").mockResolvedValue({ connections: [
    { id: "one", provider: "github", identity: "octocat", label: "octocat", status: "connected", actions: ["github.list_issues"] },
    { id: "two", provider: "github", identity: "work", label: "work", status: "connected", actions: ["github.list_issues"] },
    { id: "expired", provider: "github", identity: "expired", label: "expired", status: "reconnect_required", actions: ["github.list_issues"] },
  ] });
  const preview = vi.spyOn(api, "previewGitHubIssues").mockResolvedValue({ repository: { owner: "octo", name: "hello", fullName: "octo/hello" },
    page: 1, hasMore: false, issues: [{ number: 1, title: "Private issue", url: "https://github.com/octo/hello/issues/1", state: "open", labels: [], author: null, comments: 0, importedTaskId: null }] });
  const imported = vi.spyOn(api, "importGitHubIssues").mockResolvedValue({ created: [], skipped: [], failed: [] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <GitHubImportDrawer open onClose={vi.fn()} />
  </QueryClientProvider>);
  return { preview, imported };
}

async function choose(label: string) {
  const trigger = screen.getByRole("combobox", { name: "github_import.connection" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

it("uses the explicitly selected account for both preview and import", async () => {
  const { preview, imported } = setup();
  await waitFor(() => expect(connections.listConnections).toHaveBeenCalled());
  await choose("octocat");
  fireEvent.change(screen.getByPlaceholderText("owner/repository"), { target: { value: "octo/hello" } });
  fireEvent.click(screen.getByRole("button", { name: "github_import.load" }));
  await screen.findByText("Private issue");
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "one" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "github_import.select_issue" }));
  fireEvent.click(screen.getByRole("button", { name: "github_import.import" }));
  await waitFor(() => expect(imported).toHaveBeenCalledWith({ repository: "octo/hello", connectionId: "one", numbers: [1], projectId: undefined }));
});

it("invalidates a preview when the connection changes", async () => {
  const { preview } = setup();
  await choose("octocat");
  fireEvent.change(screen.getByPlaceholderText("owner/repository"), { target: { value: "octo/hello" } });
  fireEvent.click(screen.getByRole("button", { name: "github_import.load" }));
  await screen.findByText("Private issue");
  fireEvent.click(await screen.findByRole("checkbox", { name: "github_import.select_issue" }));
  expect((screen.getByRole("button", { name: "github_import.import" }) as HTMLButtonElement).disabled).toBe(false);
  await choose("work");
  expect(screen.queryByText("Private issue")).toBeNull();
  expect((screen.getByRole("button", { name: "github_import.import" }) as HTMLButtonElement).disabled).toBe(true);
  expect(preview).toHaveBeenCalledTimes(1);
});

it("keeps public imports anonymous by default", async () => {
  const { preview } = setup();
  fireEvent.change(screen.getByPlaceholderText("owner/repository"), { target: { value: "octo/hello" } });
  fireEvent.click(screen.getByRole("button", { name: "github_import.load" }));
  await screen.findByText("Private issue");
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ connectionId: undefined }));
});


it("shows accounts that need reconnecting as unavailable", async () => {
  setup();
  const trigger = screen.getByRole("combobox", { name: "github_import.connection" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(trigger);
  const expired = await screen.findByRole("option", { name: "expired — github_import.reconnect" });
  expect(expired.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("link", { name: "github_import.manage_connections" }).getAttribute("href")).toBe("/settings/connections");
});

it("shows a connection access error without importing any issues", async () => {
  const { preview, imported } = setup();
  preview.mockRejectedValueOnce(new api.RelayApiError("Not available", 409, "connection_unavailable"));
  await choose("octocat");
  fireEvent.change(screen.getByPlaceholderText("owner/repository"), { target: { value: "octo/hello" } });
  fireEvent.click(screen.getByRole("button", { name: "github_import.load" }));
  expect((await screen.findByRole("alert")).textContent).toBe("github_import.errors.connection_unavailable");
  expect(imported).not.toHaveBeenCalled();
});
