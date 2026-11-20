import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { AdminPage } from "../src/components/AdminPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { AdminView } from "../src/components/admin/AdminViewToggle";
import type { CurrentUser } from "../src/types";

import { configurePersonalQueryCache } from "../src/lib/personalQueryCache";

function show(section: AdminView = "users", waitlist = true) {
  const requests = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
    settings: { maxLocalComputersPerUser: 3 }, capabilities: { userEdits: true, waitlist },
    nodes: [], users: [], entries: [], total: 0, counts: { waiting: 0, invited: 0, joined: 0, declined: 0 },
    bands: Object.fromEntries(["waiting", "invited", "joined", "declined"].map(status => [status, { entries: [], total: 0 }])),
  })));
  vi.stubGlobal("fetch", requests);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configurePersonalQueryCache(client);
  function Harness() {
    const [view, setView] = useState(section);
    return <AdminPage currentUser={{ role: "admin" } as CurrentUser} section={view} onSelectSection={setView} />;
  }
  render(<QueryClientProvider client={client}><DialogProvider><Harness /></DialogProvider></QueryClientProvider>);
  return { client, paths: () => requests.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname) };
}

it("requests only settings on Organization and loads the roster when Users opens", async () => {
  const { client, paths } = show("organization");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).toEqual(["/api/v1/admin/settings"]);

  fireEvent.click(screen.getByRole("link", { name: "admin.v2.nav_users" }));
  await waitFor(() => expect(paths()).toContain("/api/v1/admin/users"));
  expect(paths()).toContain("/api/v1/admin/daemon-nodes");
  expect(paths().filter(path => path === "/api/v1/admin/settings")).toHaveLength(1);
});

it("opens Waitlist without fetching the Computer inventory", async () => {
  const { client, paths } = show("waitlist");
  await screen.findByRole("searchbox", { name: "admin.waitlist.search_placeholder" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(paths()).not.toContain("/api/v1/admin/daemon-nodes");
});

it("offers invitations instead of manual creation in the empty user roster", async () => {
  show();
  expect(screen.queryByRole("button", { name: "admin.v2.add_user_cta" })).toBeNull();
  expect(await screen.findByRole("button", { name: "admin.waitlist.invite_link_cta" })).toBeTruthy();
});

it("has no manual computer creation action, including the empty state", async () => {
  show("computers");
  await screen.findByText("admin.no_nodes");
  expect(screen.queryByRole("button", { name: "admin.v2.add_node_cta" })).toBeNull();
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
  expect(screen.getByText("admin.v2.empty_users_title")).toBeTruthy();
});

it("keeps existing waitlist links inside Users when public signup is closed", async () => {
  show("waitlist", false);
  const tabs = await screen.findByRole("navigation", { name: "admin.v2.nav_users" });
  expect(within(tabs).getByRole("link", { name: "admin.v2.nav_invitations" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { name: "admin.v2.title_users" })).toBeTruthy();
});
