import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  computerManagementDestination,
  desktopBurst,
  newlyArrivedUnread,
  notificationHref,
  notificationView,
  notificationViews,
  unreadBadgeText,
  type NotificationView,
} from "../src/lib/notifications.js";
import {
  getNotificationPreferences,
  listNotifications,
  markNotificationsRead,
  updateNotificationPreferences,
} from "../src/api.js";

const CREATED = "2026-10-16T09:00:00Z";

function notice(kind: string, data: unknown, overrides: Record<string, unknown> = {}) {
  return { id: `n-${kind}`, kind, data, createdAt: CREATED, readAt: null, ...overrides };
}

describe("notificationView", () => {
  it("opens an approval notice in the thread where the person can answer", () => {
    const view = notificationView(notice("approval_requested", {
      taskId: "t1", sessionId: "s1", questionId: "q_1", title: "Ship it", projectId: "p1",
    }));
    assert.ok(view);
    assert.equal(view.tone, "info");
    assert.deepEqual(view.title, { key: "notifications.approval_requested", params: {} });
    assert.deepEqual(view.detail, { key: "notifications.thread_detail", params: { title: "Ship it" } });
    assert.equal(notificationHref(view.target), "/projects/p1/threads/s1");
    assert.equal(notificationView(notice("approval_requested", { taskId: "t1" })), null);
  });

  it("reads a task waiting for review as an info notice that opens the task", () => {
    const view = notificationView(notice("task_completed", { taskId: "t1", title: "Fix login", status: "review", number: 12 }));
    assert.ok(view);
    assert.equal(view.tone, "info");
    assert.equal(view.unread, true);
    assert.deepEqual(view.title, { key: "notifications.task_review", params: {} });
    assert.deepEqual(view.detail, { key: "notifications.task_detail", params: { ref: "#12", title: "Fix login" } });
    assert.deepEqual(view.target, { kind: "task", taskId: "t1", routineId: null });
    assert.equal(notificationHref(view.target), "/tasks/t1");
  });

  it("reads a finished task as good, and falls back to the id without a number or title", () => {
    const view = notificationView(notice("task_completed", { taskId: "t2", title: "  ", status: "done" }));
    assert.ok(view);
    assert.equal(view.tone, "good");
    assert.deepEqual(view.title, { key: "notifications.task_done", params: {} });
    assert.deepEqual(view.detail, { key: "notifications.task_detail_untitled", params: { ref: "t2" } });
  });

  it("numbers an automation's occurrence like an issue and opens it as a run of its routine", () => {
    const view = notificationView(notice("task_completed", {
      taskId: "occ1", title: "Nightly sync", status: "review", number: 3, sourceRoutineId: "r1",
    }));
    assert.ok(view);
    assert.equal(view.detail.params.ref, "#3");
    assert.deepEqual(view.target, { kind: "task", taskId: "occ1", routineId: "r1" });
    assert.equal(notificationHref(view.target), "/automations/r1/runs/occ1");
  });

  it("reads a paused run's prompt as an info notice that opens its thread", () => {
    const view = notificationView(notice("permission_requested", { sessionId: "ses_1", requestId: "perm_1", toolName: "Bash", agent: "claude", question: false, title: "Clean up" }));
    assert.ok(view);
    assert.equal(view.tone, "info");
    assert.deepEqual(view.title, { key: "notifications.permission_requested", params: { tool: "Bash" } });
    assert.deepEqual(view.detail, { key: "notifications.thread_detail", params: { title: "Clean up" } });
    assert.deepEqual(view.target, { kind: "thread", sessionId: "ses_1", projectId: null });
    assert.equal(notificationHref(view.target), "/threads/ses_1");
    const question = notificationView(notice("permission_requested", { sessionId: "ses_2", requestId: "perm_2", toolName: "AskUserQuestion", question: true, projectId: "proj_1" }));
    assert.deepEqual(question?.title, { key: "notifications.permission_question", params: { tool: "AskUserQuestion" } });
    assert.deepEqual(question?.detail, { key: "notifications.thread_detail_untitled", params: {} });
    assert.equal(notificationHref(question!.target), "/projects/proj_1/threads/ses_2");
    assert.equal(notificationView(notice("permission_requested", { sessionId: "ses_3" })), null);
  });

  it("reads computer liveness and opens where the computer is managed", () => {
    const offline = notificationView(notice("computer_status", { nodeId: "node1", computerName: "Office Mac", from: "online", to: "offline" }));
    assert.ok(offline);
    assert.equal(offline.tone, "warn");
    assert.equal(offline.title.key, "notifications.computer_offline");
    assert.deepEqual(offline.detail, { key: "notifications.computer_detail", params: { name: "Office Mac" } });
    assert.equal(notificationHref(offline.target), "/computers");
    assert.equal(notificationHref(offline.target, "admin"), "/admin/computers");

    const online = notificationView(notice("computer_status", { nodeId: "node1", to: "online" }));
    assert.equal(online?.tone, "good");
    assert.equal(online?.title.key, "notifications.computer_online");
    // No name: the id stands in rather than an empty line.
    assert.equal(online?.detail.params.name, "node1");
  });

  it("reads an outdated client as a warning about that computer", () => {
    const view = notificationView(notice("client_outdated", { nodeId: "node2", computerName: "Lab box", missingCapabilities: ["agent-model"] }));
    assert.ok(view);
    assert.equal(view.tone, "warn");
    assert.equal(view.title.key, "notifications.client_outdated");
    assert.deepEqual(view.detail, { key: "notifications.client_outdated_detail", params: { name: "Lab box" } });
    assert.deepEqual(view.target, { kind: "computer", nodeId: "node2" });
  });

  it("marks a notice with a read time as read", () => {
    const view = notificationView(notice("client_outdated", { nodeId: "node2" }, { readAt: "2026-10-16T10:00:00Z" }));
    assert.equal(view?.unread, false);
  });

  it("skips what it cannot read instead of rendering half a notice", () => {
    assert.equal(notificationView(null), null);
    assert.equal(notificationView("nope"), null);
    assert.equal(notificationView(notice("project_archived", { projectId: "p1" })), null, "unknown kind");
    assert.equal(notificationView(notice("toString", {})), null, "prototype key is not a kind");
    assert.equal(notificationView(notice("task_completed", { title: "No id", status: "done" })), null);
    assert.equal(notificationView(notice("task_completed", { taskId: "t1", status: "blocked" })), null);
    assert.equal(notificationView(notice("task_completed", "not an object")), null);
    assert.equal(notificationView(notice("task_completed", ["t1"])), null);
    assert.equal(notificationView(notice("computer_status", { nodeId: "n", to: "sleeping" })), null);
    assert.equal(notificationView(notice("client_outdated", { nodeId: 42 })), null);
    assert.equal(notificationView({ ...notice("client_outdated", { nodeId: "n" }), id: "" }), null);
    assert.equal(notificationView({ ...notice("client_outdated", { nodeId: "n" }), createdAt: undefined }), null);
  });

  it("ignores a non-integer number rather than printing it as a ref", () => {
    const view = notificationView(notice("task_completed", { taskId: "t3", status: "done", number: "12" }));
    assert.equal(view?.detail.params.ref, "t3");
  });

  it("keeps the readable notices of a list in order", () => {
    const views = notificationViews([
      notice("client_outdated", { nodeId: "a" }, { id: "1" }),
      notice("mystery", {}, { id: "2" }),
      notice("computer_status", { nodeId: "b", to: "online" }, { id: "3" }),
    ]);
    assert.deepEqual(views.map((view) => view.id), ["1", "3"]);
    assert.deepEqual(notificationViews(undefined), []);
    assert.deepEqual(notificationViews({ notifications: [] }), []);
  });
});

describe("unreadBadgeText", () => {
  it("shows nothing at zero and caps the count at 9+", () => {
    assert.equal(unreadBadgeText(0), "");
    assert.equal(unreadBadgeText(-1), "");
    assert.equal(unreadBadgeText(Number.NaN), "");
    assert.equal(unreadBadgeText(1), "1");
    assert.equal(unreadBadgeText(9), "9");
    assert.equal(unreadBadgeText(10), "9+");
  });
});

describe("newlyArrivedUnread", () => {
  const view = (id: string, unread = true): NotificationView => ({
    id,
    kind: "client_outdated",
    unread,
    createdAt: CREATED,
    tone: "warn",
    title: { key: "notifications.client_outdated", params: {} },
    detail: { key: "notifications.client_outdated_detail", params: { name: id } },
    target: { kind: "computer", nodeId: id },
  });

  it("announces nothing on the first read, however much is unread", () => {
    assert.deepEqual(newlyArrivedUnread(null, [view("a"), view("b")]), []);
  });

  it("announces only unread notices the previous read did not have", () => {
    const arrivals = newlyArrivedUnread(new Set(["a"]), [view("c"), view("b", false), view("a")]);
    assert.deepEqual(arrivals.map((item) => item.id), ["c"]);
  });

  it("caps a burst and folds the rest into a summary", () => {
    const arrivals = ["a", "b", "c", "d", "e"].map((id) => view(id));
    const { shown, overflow } = desktopBurst(arrivals);
    assert.deepEqual(shown.map((item) => item.id), ["a", "b", "c"]);
    assert.equal(overflow, 2);
    assert.deepEqual(desktopBurst(arrivals.slice(0, 2)).overflow, 0);
  });
});

describe("computerManagementDestination", () => {
  it("opens the person's own computer on the Computers page, and shared hardware in the control panel for an admin", () => {
    const own = new Set(["mine"]);
    assert.equal(computerManagementDestination("mine", { isAdmin: true, ownNodeIds: own }), "computers");
    assert.equal(computerManagementDestination("shared", { isAdmin: true, ownNodeIds: own }), "admin");
    assert.equal(computerManagementDestination("shared", { isAdmin: false, ownNodeIds: own }), "computers");
  });
});

describe("notification API client", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function capture(body: unknown) {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return calls;
  }

  it("lists the inbox with the session cookie", async () => {
    const calls = capture({ notifications: [], unreadCount: 0 });
    const result = await listNotifications();
    assert.deepEqual(result, { notifications: [], unreadCount: 0 });
    assert.match(calls[0].url, /\/api\/v1\/notifications\?limit=50$/);
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].init?.credentials, "include");
  });

  it("marks named notices read, or all of them", async () => {
    const calls = capture({ unreadCount: 1 });
    assert.deepEqual(await markNotificationsRead(["n1", "n2"]), { unreadCount: 1 });
    await markNotificationsRead("all");
    assert.match(calls[0].url, /\/api\/v1\/notifications\/read$/);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, JSON.stringify({ ids: ["n1", "n2"] }));
    assert.equal(calls[1].init?.body, JSON.stringify({ all: true }));
  });

  it("reads and replaces the muted kinds", async () => {
    const calls = capture({ mutedKinds: ["computer_status"], kinds: ["task_completed", "computer_status"] });
    assert.deepEqual((await getNotificationPreferences()).mutedKinds, ["computer_status"]);
    await updateNotificationPreferences(["computer_status"]);
    assert.match(calls[0].url, /\/api\/v1\/notifications\/preferences$/);
    assert.equal(calls[1].init?.method, "PUT");
    assert.equal(calls[1].init?.body, JSON.stringify({ mutedKinds: ["computer_status"] }));
  });
});
