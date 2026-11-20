import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { AdminPage } from "../src/components/AdminPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { AdminView } from "../src/components/admin/AdminViewToggle";
import type { CurrentUser } from "../src/types";

import { configurePersonalQueryCache } from "../src/lib/personalQueryCache";

function show(section: AdminView = "users", waitlist = true, responseFor?: (url: URL) => object | undefined) {
  const requests = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    return Response.json(responseFor?.(url) ?? (url.pathname.endsWith("/admin/users") ? {
      users: [], nodes: [], page: { page: 1, total: 0 }, userCount: 0, displayOrder: [],
      counts: { all: 0, running: 0, ready: 0, failed: 0, idle: 0, unassigned: 0 },
    } : {
      settings: { maxLocalComputersPerUser: 3 }, capabilities: { userEdits: true, waitlist },
      nodes: [], entries: [], total: 0, counts: { waiting: 0, invited: 0, joined: 0, declined: 0 },
      topUsers: [], dailyCounts: [],
      bands: Object.fromEntries(["waiting", "invited", "joined", "declined"].map(status => [status, { entries: [], total: 0 }])),
    }));
  });
  vi.stubGlobal("fetch", requests);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configurePersonalQueryCache(client);
  function Harness() {
    const [view, setView] = useState(section);
    return <AdminPage currentUser={{ role: "admin" } as CurrentUser} section={view} onSelectSection={setView} />;
  }
  render(<QueryClientProvider client={client}><DialogProvider><Harness /></DialogProvider></QueryClientProvider>);
  const urls = () => requests.mock.calls.map(([input]) => new URL(String(input), "http://localhost"));
  return { client, urls, paths: () => urls().map(url => url.pathname) };
}

it("requests only settings on Organization and loads a roster page when Users opens", async () => {
  const { client, paths, urls } = show("organization");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).toEqual(["/api/v1/admin/settings"]);

  fireEvent.click(screen.getByRole("link", { name: "admin.v2.nav_users" }));
  await waitFor(() => expect(paths()).toContain("/api/v1/admin/users"));
  await screen.findByText("admin.v2.empty_users_title");
  expect(paths()).not.toContain("/api/v1/admin/daemon-nodes");
  expect(urls().find(url => url.pathname.endsWith("/admin/users"))?.searchParams.get("view")).toBe("web");
  expect(paths().filter(path => path === "/api/v1/admin/settings")).toHaveLength(1);
});

it("opens Waitlist without fetching the Computer inventory", async () => {
  const { client, paths } = show("waitlist");
  await screen.findByRole("searchbox", { name: "admin.waitlist.search_placeholder" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).not.toContain("/api/v1/admin/daemon-nodes");
  expect(paths()).not.toContain("/api/v1/admin/users");
});

it("opens the Dashboard without requesting the full user directory", async () => {
  const { client, paths } = show("dashboard");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).toContain("/api/v1/admin/dashboard/sessions");
  expect(paths()).not.toContain("/api/v1/admin/users");
});

it("offers invitations instead of manual creation in the empty user roster", async () => {
  show();
  expect(screen.queryByRole("button", { name: "admin.v2.add_user_cta" })).toBeNull();
  expect(await screen.findByRole("button", { name: "admin.waitlist.invite_link_cta" })).toBeTruthy();
});

it("has no manual computer creation action, including the empty state", async () => {
  const { client, paths } = show("computers");
  await screen.findByText("admin.no_nodes");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).not.toContain("/api/v1/admin/users");
  expect(screen.queryByRole("button", { name: "admin.v2.add_node_cta" })).toBeNull();
});

it("gets owner labels with the Computer history and loads older pages on request", async () => {
  const ownerLabel = { id: "alice", displayName: "Alice Example", handle: "alice" };
  const deleted = { userId: "alice", ownerLabel, desiredState: "deleted", phase: "deleted",
    provider: "fly-machines", profile: "standard", updatedAt: "2026-11-20T00:00:00Z" };
  const { urls } = show("computers", true, url => {
    if (url.pathname.endsWith("/managed-nodes")) {
      return url.searchParams.has("cursor")
        ? { nodes: [{ ...deleted, id: "older", displayName: "Older computer" }], nextCursor: null }
        : { nodes: [{ ...deleted, id: "newer", displayName: "Newer computer" }], nextCursor: "older-page" };
    }
    return undefined;
  });
  expect(await screen.findByText("Newer computer")).toBeTruthy();
  expect(screen.getByText(/^@alice/)).toBeTruthy();
  expect(screen.queryByText("Older computer")).toBeNull();
  const historyReads = () => urls().filter(url => url.pathname.endsWith("/managed-nodes"));
  expect(historyReads()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "admin.v2.history_load_more" }));
  expect(await screen.findByText("Older computer")).toBeTruthy();
  expect(historyReads().map(url => url.searchParams.get("cursor"))).toEqual([null, "older-page"]);
  expect(screen.queryByRole("button", { name: "admin.v2.history_load_more" })).toBeNull();
});

it("opens the waitlist within Users and returns to the roster", async () => {
  show();
  const tabs = await screen.findByRole("navigation", { name: "admin.v2.nav_users" });
  fireEvent.click(await within(tabs).findByRole("link", { name: "admin.v2.nav_waitlist" }));
  expect(screen.getByRole("heading", { name: "admin.v2.title_users" })).toBeTruthy();
  expect(await screen.findByRole("searchbox", { name: "admin.waitlist.search_placeholder" })).toBeTruthy();
  const rail = screen.getByRole("navigation", { name: "admin.v2.nav_label" });
  expect(within(rail).queryByRole("link", { name: "admin.v2.nav_waitlist" })).toBeNull();
  expect(within(rail).getByRole("link", { name: "admin.v2.nav_users" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(within(tabs).getByRole("link", { name: "admin.v2.nav_users" }));
  expect(await screen.findByText("admin.v2.empty_users_title")).toBeTruthy();
});

it("keeps existing waitlist links inside Users when public signup is closed", async () => {
  show("waitlist", false);
  const tabs = await screen.findByRole("navigation", { name: "admin.v2.nav_users" });
  expect(within(tabs).getByRole("link", { name: "admin.v2.nav_invitations" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { name: "admin.v2.title_users" })).toBeTruthy();
});
