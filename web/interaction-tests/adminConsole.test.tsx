import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { AdminPage } from "../src/components/AdminPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { AdminView } from "../src/components/admin/AdminViewToggle";
import type { CurrentUser } from "../src/types";

vi.mock("../src/hooks/useAdminNodes", () => {
  const result = { nodes: [], users: [], pollError: null, mergeNodes: vi.fn(), refetch: vi.fn() };
  return { useAdminNodes: () => result };
});

function show(section: AdminView = "users", waitlist = true) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    settings: { maxLocalComputersPerUser: 3 }, capabilities: { userEdits: true, waitlist },
    nodes: [], entries: [], total: 0, counts: { waiting: 0, invited: 0, joined: 0, declined: 0 },
  }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [view, setView] = useState(section);
    return <AdminPage currentUser={{ role: "admin" } as CurrentUser} section={view} onSelectSection={setView} />;
  }
  return render(<QueryClientProvider client={client}><DialogProvider><Harness /></DialogProvider></QueryClientProvider>);
}

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
