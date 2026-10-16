import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useState, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { waitlistPollIntervalMs } from "../src/components/admin/waitlist/useWaitlistQueue";
import { WaitlistView } from "../src/components/admin/waitlist/WaitlistView";
import { ADMIN_ROSTER_POLL_MS, CONTROL_PANEL_POLL_MS } from "../src/lib/controlPanelQueries";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { WaitlistEntry, WaitlistInviteResult, WaitlistStatus } from "../src/types";

// base-ui menus never open under jsdom; render the items inline.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => createElement("div", null, children),
  DropdownMenuTrigger: ({ render }: any) => render,
  DropdownMenuContent: ({ children }: any) => createElement("div", { role: "menu" }, children),
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onClick, danger: _danger }: any) => createElement("div", { role: "menuitem", onClick }, children),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><DialogProvider>{children}</DialogProvider></QueryClientProvider>;
}

function entry(id: string, status: WaitlistStatus, extra: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id, email: `${id}@example.com`, name: null, company: null, role: null, useCase: null, source: null, locale: "en",
    status, inviteExpiresAt: null, inviteExpired: false, invitedAt: null, invitedByUserId: null, accountId: null,
    adminNote: null, lastDeliveryStatus: null, lastDeliveryError: null, lastDeliveredAt: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
  };
}

const QUEUE: Record<WaitlistStatus, WaitlistEntry[]> = {
  waiting: [entry("ada", "waiting", { name: "Ada", useCase: "Triage tickets" }), entry("bob", "waiting")],
  invited: [entry("cy", "invited", { inviteExpired: true, lastDeliveryStatus: "bounced", lastDeliveryError: "mailbox full" })],
  joined: [],
  declined: [],
};

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://relay.test");
    calls.push({ url: url.toString(), init });
    if (url.pathname.endsWith("/invite")) {
      const result: WaitlistInviteResult = {
        entry: { ...QUEUE.waiting[0], status: "invited" },
        inviteUrl: "https://relay.test/join#token=secret-once",
        delivery: { status: "skipped", error: null },
      };
      return new Response(JSON.stringify(result));
    }
    const status = url.searchParams.get("status") as WaitlistStatus;
    const counts = { waiting: 2, invited: 1, joined: 0, declined: 0 };
    return new Response(JSON.stringify({ entries: QUEUE[status], total: QUEUE[status].length, counts }));
  }));
  return calls;
}

/** The page's part: it holds the minted links so they survive a re-render. */
function Harness() {
  const [invites, setInvites] = useState<WaitlistInviteResult[] | null>(null);
  return <WaitlistView invites={invites} onInvited={setInvites} onDismissInvites={() => setInvites(null)} />;
}

it("groups the queue by status and hides empty bands", async () => {
  const calls = stubFetch();
  render(<Harness />, { wrapper });
  const waiting = await screen.findByRole("region", { name: "admin.waitlist.status_waiting" });
  expect(within(waiting).getByText("Ada")).toBeTruthy();
  expect(within(waiting).getByText("bob@example.com")).toBeTruthy();
  const invited = screen.getByRole("region", { name: "admin.waitlist.status_invited" });
  expect(within(invited).getByText("admin.waitlist.invite_expired")).toBeTruthy();
  expect(within(invited).getByText("admin.waitlist.delivery_bounced")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "admin.waitlist.status_joined" })).toBeNull();
  expect(screen.queryByRole("region", { name: "admin.waitlist.status_declined" })).toBeNull();
  const statuses = calls.map((call) => new URL(call.url).searchParams.get("status"));
  expect(statuses).toEqual(expect.arrayContaining(["waiting", "invited", "joined", "declined"]));
});

it("reveals a minted invite link once, until it is dismissed", async () => {
  const calls = stubFetch();
  render(<Harness />, { wrapper });
  const waiting = await screen.findByRole("region", { name: "admin.waitlist.status_waiting" });
  const adaRow = within(waiting).getByText("Ada").closest("tr")!;
  // Waiting rows offer Invite; an invited row would offer Re-invite.
  fireEvent.click(within(adaRow).getByText("admin.waitlist.invite"));
  expect(await screen.findByText("https://relay.test/join#token=secret-once")).toBeTruthy();
  expect(screen.getByText("admin.waitlist.reveal_once")).toBeTruthy();
  const invite = calls.find((call) => call.init?.method === "POST")!;
  expect(new URL(invite.url).pathname).toMatch(/\/admin\/waitlist\/ada\/invite$/);

  fireEvent.click(screen.getByRole("button", { name: "admin.v2.dismiss" }));
  await waitFor(() => expect(screen.queryByText("https://relay.test/join#token=secret-once")).toBeNull());
});

it("offers re-invite, not invite, on an invited row", async () => {
  stubFetch();
  render(<Harness />, { wrapper });
  const invited = await screen.findByRole("region", { name: "admin.waitlist.status_invited" });
  expect(within(invited).getByText("admin.waitlist.reinvite")).toBeTruthy();
  expect(within(invited).queryByText("admin.waitlist.invite")).toBeNull();
});

it("refreshes background delivery failures without leaving stale queued results in the reveal", async () => {
  let delivered = false;
  const issued = entry("pending", "invited", { lastDeliveryStatus: "queued" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://relay.test");
    const status = url.searchParams.get("status");
    const entries = status === "invited" ? [{ ...issued,
      lastDeliveryStatus: delivered ? "failed" : "queued",
      lastDeliveryError: delivered ? "Delivery timed out" : null,
    }] : [];
    return new Response(JSON.stringify({ entries, total: entries.length, counts: {} }));
  }));
  vi.useFakeTimers();
  render(<WaitlistView invites={[{
    entry: issued, inviteUrl: "https://relay.test/join#token=pending", delivery: { status: "queued", error: null },
  }]} onInvited={vi.fn()} onDismissInvites={vi.fn()} />, { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(10));
  const invited = screen.getByRole("region", { name: "admin.waitlist.status_invited" });
  expect(within(invited).getByText("admin.waitlist.delivery_queued")).toBeTruthy();
  delivered = true;
  try {
    await act(() => vi.advanceTimersByTimeAsync(10_000));
  } finally {
    vi.useRealTimers();
  }
  expect(await within(invited).findByText("admin.waitlist.delivery_failed")).toBeTruthy();
  const reveal = screen.getByRole("region", { name: "admin.waitlist.reveal_title" });
  expect(within(reveal).queryByText("admin.waitlist.delivery_queued")).toBeNull();
  expect(within(reveal).getByText("https://relay.test/join#token=pending")).toBeTruthy();
});

it("polls a band quickly only while one of its invite emails is still queued", () => {
  expect(waitlistPollIntervalMs(undefined)).toBe(ADMIN_ROSTER_POLL_MS);
  expect(waitlistPollIntervalMs([entry("a", "invited", { lastDeliveryStatus: "failed" })])).toBe(ADMIN_ROSTER_POLL_MS);
  expect(waitlistPollIntervalMs([
    entry("a", "invited", { lastDeliveryStatus: "sent" }),
    entry("b", "invited", { lastDeliveryStatus: "queued" }),
  ])).toBe(CONTROL_PANEL_POLL_MS);
});
