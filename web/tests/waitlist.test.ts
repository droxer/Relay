import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  deliveryLabelKey,
  deliveryTone,
  EMPTY_WAITLIST_FIELDS,
  inviteState,
  inviteTokenFromHash,
  isWaitlistEmail,
  pageOffset,
  parseInviteBatch,
  serverPage,
  WAITLIST_LIMITS,
  WAITLIST_STATUS_ORDER,
  waitlistFieldProblems,
  waitlistJoinInput,
  waitlistLocale,
  waitlistSource,
} from "../src/lib/waitlist.js";
import { canonicalBrowserUrl, parseAppPath, pathForAppState, validatedReturnTo } from "../src/lib/appRoute.js";
import { getAuthStatus, listWaitlist } from "../src/api.js";

const ORIGIN = "https://relay.example.com";

describe("waitlist email shape", () => {
  it("accepts an ordinary address and refuses obvious non-addresses", () => {
    assert.equal(isWaitlistEmail("ada@example.com"), true);
    assert.equal(isWaitlistEmail("  ada@example.com  "), true);
    assert.equal(isWaitlistEmail("ada@example"), false);
    assert.equal(isWaitlistEmail("ada example.com"), false);
    assert.equal(isWaitlistEmail("@example.com"), false);
  });

  it("refuses an address over the 254-character cap", () => {
    const long = `${"a".repeat(250)}@example.com`;
    assert.equal(isWaitlistEmail(long), false);
  });
});

describe("waitlist form problems", () => {
  it("requires only the email", () => {
    assert.deepEqual(waitlistFieldProblems(EMPTY_WAITLIST_FIELDS), { email: "required" });
    assert.deepEqual(waitlistFieldProblems({ ...EMPTY_WAITLIST_FIELDS, email: "ada@example.com" }), {});
  });

  it("names an invalid email and every over-long optional field", () => {
    const problems = waitlistFieldProblems({
      email: "not-an-email",
      name: "n".repeat(WAITLIST_LIMITS.name + 1),
      company: "c".repeat(WAITLIST_LIMITS.company),
      role: "r".repeat(WAITLIST_LIMITS.role + 1),
      useCase: "u".repeat(WAITLIST_LIMITS.useCase + 1),
    });
    assert.deepEqual(problems, { email: "invalid", name: "too_long", role: "too_long", useCase: "too_long" });
  });

  it("builds a trimmed body, drops empty optionals, and always carries the honeypot", () => {
    const input = waitlistJoinInput(
      { email: " ada@example.com ", name: " Ada ", company: "", role: "  ", useCase: "Triage tickets" },
      { honeypot: "", source: "hn", locale: "en" },
    );
    assert.deepEqual(input, {
      email: "ada@example.com",
      name: "Ada",
      company: undefined,
      role: undefined,
      useCase: "Triage tickets",
      source: "hn",
      locale: "en",
      website: "",
    });
    assert.equal(waitlistJoinInput(EMPTY_WAITLIST_FIELDS, { honeypot: "bot" }).website, "bot");
  });
});

describe("waitlistSource", () => {
  it("prefers utm_source over the referrer", () => {
    assert.equal(waitlistSource({ search: "?utm_source=hn", origin: ORIGIN }, "https://news.ycombinator.com/item"), "hn");
  });

  it("falls back to the referring host, but not our own", () => {
    assert.equal(waitlistSource({ search: "", origin: ORIGIN }, "https://news.ycombinator.com/item?id=1"), "news.ycombinator.com");
    assert.equal(waitlistSource({ search: "", origin: ORIGIN }, `${ORIGIN}/login`), undefined);
    assert.equal(waitlistSource({ search: "", origin: ORIGIN }, ""), undefined);
    assert.equal(waitlistSource({ search: "", origin: ORIGIN }, "not a url"), undefined);
  });

  it("caps the source at 120 characters", () => {
    const source = waitlistSource({ search: `?utm_source=${"x".repeat(200)}`, origin: ORIGIN }, "");
    assert.equal(source?.length, WAITLIST_LIMITS.source);
  });
});

describe("waitlistLocale", () => {
  it("maps the UI language onto the backend's two locales", () => {
    assert.equal(waitlistLocale("zh-CN"), "zh-CN");
    assert.equal(waitlistLocale("zh"), "zh-CN");
    assert.equal(waitlistLocale("en"), "en");
    assert.equal(waitlistLocale(undefined), "en");
  });
});

describe("inviteTokenFromHash", () => {
  it("reads the token from the fragment", () => {
    assert.equal(inviteTokenFromHash("#token=abc_DEF-123"), "abc_DEF-123");
    assert.equal(inviteTokenFromHash("token=abc"), "abc");
  });

  it("refuses an absent or malformed token", () => {
    assert.equal(inviteTokenFromHash(""), null);
    assert.equal(inviteTokenFromHash("#other=1"), null);
    assert.equal(inviteTokenFromHash("#token="), null);
    assert.equal(inviteTokenFromHash("#token=a%20b"), null);
    assert.equal(inviteTokenFromHash(`#token=${"a".repeat(600)}`), null);
  });
});

describe("waitlist queue grouping", () => {
  it("reads the bands in lifecycle order", () => {
    assert.deepEqual(WAITLIST_STATUS_ORDER, ["waiting", "invited", "joined", "declined"]);
  });

  it("derives expiry only for invited entries", () => {
    assert.equal(inviteState({ status: "invited", inviteExpired: false }), "live");
    assert.equal(inviteState({ status: "invited", inviteExpired: true }), "expired");
    assert.equal(inviteState({ status: "waiting", inviteExpired: true }), null);
  });

  it("labels and tones every delivery outcome", () => {
    assert.equal(deliveryLabelKey("bounced"), "admin.waitlist.delivery_bounced");
    assert.equal(deliveryTone("sent"), "good");
    assert.equal(deliveryTone("failed"), "bad");
    assert.equal(deliveryTone("skipped"), "neutral");
  });

  it("shapes a server page for the pager", () => {
    assert.equal(pageOffset(3, 10), 20);
    assert.equal(pageOffset(0, 10), 0);
    assert.deepEqual(serverPage(["a", "b"], 2, 12, 10), {
      items: ["a", "b"], page: 2, pageCount: 2, total: 12, from: 11, to: 12, needed: true,
    });
    assert.deepEqual(serverPage([], 1, 0, 10), {
      items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0, needed: false,
    });
  });

  it("bounds the Invite next N field to 1–50", () => {
    assert.equal(parseInviteBatch("10"), 10);
    assert.equal(parseInviteBatch(" 50 "), 50);
    assert.equal(parseInviteBatch("0"), null);
    assert.equal(parseInviteBatch("51"), null);
    assert.equal(parseInviteBatch("2.5"), null);
  });
});

describe("waitlist routes", () => {
  it("parses the two public pages and writes them back", () => {
    assert.equal(parseAppPath("/waitlist").publicPage, "waitlist");
    assert.equal(parseAppPath("/join").publicPage, "join");
    assert.equal(parseAppPath("/waitlist").notFound, undefined);
    assert.equal(pathForAppState({ route: "main", mobileView: "chat", sessionId: null, publicPage: "join" }), "/join");
  });

  it("keeps utm_source on /waitlist and never returns a signed-in user to a public page", () => {
    assert.equal(canonicalBrowserUrl("/waitlist", "?utm_source=hn&x=1"), "/waitlist?utm_source=hn");
    assert.equal(validatedReturnTo("/waitlist"), "/threads");
    assert.equal(validatedReturnTo("/join"), "/threads");
  });

  it("addresses the admin Waitlist section and keeps its lane cursor", () => {
    assert.equal(parseAppPath("/admin/waitlist").adminSection, "waitlist");
    assert.equal(canonicalBrowserUrl("/admin/waitlist", "?waitlistLanes=waiting:2"), "/admin/waitlist?waitlistLanes=waiting%3A2");
  });
});

describe("waitlist API client", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads a missing waitlistEnabled or passwordResetEnabled as off", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ requiresBootstrap: false }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await getAuthStatus(), { requiresBootstrap: false, waitlistEnabled: false, passwordResetEnabled: false });
  });

  it("asks for one status band's page, oldest first, with the search trimmed", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({ entries: [], total: 0, counts: { waiting: 0, invited: 0, joined: 0, declined: 0 } }));
    }) as typeof fetch;
    await listWaitlist({ status: "invited", q: "  ada ", limit: 10, offset: 20 });
    const url = new URL(requested, ORIGIN);
    assert.match(url.pathname, /\/api\/v1\/admin\/waitlist$/);
    assert.equal(url.searchParams.get("status"), "invited");
    assert.equal(url.searchParams.get("q"), "ada");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("offset"), "20");
  });
});
