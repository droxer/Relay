import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mobileTopbarMode } from "../src/lib/mobileTopbar.js";

const base = { taskThread: false, taskWorkspace: false, notFound: false, mobileView: "chat" } as const;

describe("mobileTopbarMode", () => {
  it("titles an open conversation with the thread", () => {
    assert.deepEqual(mobileTopbarMode({ ...base, route: "main" }), {
      threadRoute: true,
      chat: true,
      titleKey: null,
      directoryKey: "nav.threads",
    });
  });

  it("names the directory over the thread list", () => {
    const mode = mobileTopbarMode({ ...base, route: "projects", mobileView: "threads" });
    assert.equal(mode.chat, false);
    assert.equal(mode.titleKey, "project.projects");
  });

  it("names a work route after itself", () => {
    const mode = mobileTopbarMode({ ...base, route: "backlog" });
    assert.equal(mode.threadRoute, false);
    assert.equal(mode.titleKey, "nav.backlog");
  });

  /* An unknown path parses as `main`; it used to borrow the open thread's
     title, back arrow, and files toggle over the not-found page. */
  it("never dresses a not-found page as a conversation", () => {
    assert.deepEqual(mobileTopbarMode({ ...base, route: "main", notFound: true }), {
      threadRoute: false,
      chat: false,
      titleKey: "route_not_found.title",
      directoryKey: "nav.threads",
    });
  });
});
