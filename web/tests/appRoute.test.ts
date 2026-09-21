import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  browserUrlForAppState,
  canonicalBrowserUrl,
  hrefForRoute,
  hrefForAdminSection,
  hrefForSettingsSection,
  parseAppPath,
  pathForAppState,
  pathKeepsThreadSpaceParams,
  validatedReturnTo,
} from "../src/lib/appRoute.js";

describe("app pathname routes", () => {
  it("parses every canonical collection and detail path", () => {
    assert.deepEqual(parseAppPath("/threads"), { route: "main", mobileView: "threads", sessionId: null });
    assert.deepEqual(parseAppPath("/threads/new"), { route: "main", mobileView: "chat", sessionId: null, composingNew: true });
    assert.deepEqual(parseAppPath("/threads/ses%2F123"), { route: "main", mobileView: "chat", sessionId: "ses/123" });
    assert.deepEqual(parseAppPath("/projects"), { route: "projects", mobileView: "threads", sessionId: null });
    assert.deepEqual(parseAppPath("/projects/prj%2F123"), { route: "projects", mobileView: "chat", sessionId: null, projectId: "prj/123" });
    assert.deepEqual(parseAppPath("/projects/prj%2F123/new"), { route: "projects", mobileView: "chat", sessionId: null, projectId: "prj/123", composingNew: true });
    assert.deepEqual(parseAppPath("/projects/prj%2F123/threads/ses%2F123"), { route: "projects", mobileView: "chat", sessionId: "ses/123", projectId: "prj/123" });
    assert.deepEqual(parseAppPath("/agents/agent%201"), { route: "agents", mobileView: "chat", sessionId: null, agentId: "agent 1" });
    assert.deepEqual(parseAppPath("/teams/team%201"), { route: "teams", mobileView: "chat", sessionId: null, teamWorkspaceId: "team 1" });

    const routes = {
      "/backlog": "backlog",
      "/routines": "routine",
      "/agents": "agents",
      "/teams": "teams",
      "/channels": "channels",
      "/admin": "admin",
      "/settings": "settings",
    } as const;
    for (const [path, route] of Object.entries(routes)) {
      assert.equal(parseAppPath(path).route, route);
    }
  });

  it("parses a settings section, and keeps the paths its sections came from", () => {
    assert.deepEqual(parseAppPath("/settings"), {
      route: "settings", mobileView: "chat", sessionId: null, settingsSection: "computers",
    });
    assert.deepEqual(parseAppPath("/settings/skills"), {
      route: "settings", mobileView: "chat", sessionId: null, settingsSection: "skills",
    });
    assert.deepEqual(parseAppPath("/settings/appearance"), {
      route: "settings", mobileView: "chat", sessionId: null, settingsSection: "appearance",
    });
    // Computers and Skills were routes of their own before they became
    // settings sections; their links still resolve.
    assert.deepEqual(parseAppPath("/computer"), {
      route: "settings", mobileView: "chat", sessionId: null, settingsSection: "computers",
    });
    assert.deepEqual(parseAppPath("/skills"), {
      route: "settings", mobileView: "chat", sessionId: null, settingsSection: "skills",
    });
    // An unknown section is a bad link, not the default section.
    assert.equal(parseAppPath("/settings/nope").notFound, true);
  });

  it("parses a control-panel section", () => {
    // The control panel's sections are destinations, so each has an address:
    // a reload or a shared link opens the section it names, not Dashboard.
    assert.deepEqual(parseAppPath("/admin"), {
      route: "admin", mobileView: "chat", sessionId: null, adminSection: "dashboard",
    });
    assert.deepEqual(parseAppPath("/admin/employees"), {
      route: "admin", mobileView: "chat", sessionId: null, adminSection: "employees",
    });
    assert.deepEqual(parseAppPath("/admin/computers"), {
      route: "admin", mobileView: "chat", sessionId: null, adminSection: "computers",
    });
    assert.deepEqual(parseAppPath("/admin/organization"), {
      route: "admin", mobileView: "chat", sessionId: null, adminSection: "organization",
    });
    // An unknown section is a bad link, not the default section — same rule
    // the settings sections follow.
    assert.equal(parseAppPath("/admin/nope").notFound, true);
  });

  it("writes only the canonical control-panel path", () => {
    assert.equal(hrefForRoute("admin"), "/admin/dashboard");
    assert.equal(hrefForAdminSection("computers"), "/admin/computers");
    assert.equal(
      pathForAppState({ route: "admin", mobileView: "chat", sessionId: null, adminSection: "organization" }),
      "/admin/organization",
    );
  });

  it("keeps the admin tables' params now that the section is a path segment", () => {
    // The section segment made /admin look like an entity path, which would
    // have dropped every sort, page, and filter the two tables write.
    assert.equal(
      canonicalBrowserUrl("/admin/employees", "?employeeSort=-running&employeePage=2"),
      "/admin/employees?employeeSort=-running&employeePage=2",
    );
    assert.equal(
      canonicalBrowserUrl("/admin/computers", "?nodeSort=node&nodeLanes=ready%3A2"),
      "/admin/computers?nodeSort=node&nodeLanes=ready%3A2",
    );
    // A param the path does not own still goes.
    assert.equal(canonicalBrowserUrl("/admin/employees", "?sort=-due"), "/admin/employees");
  });

  it("writes only the canonical settings path", () => {
    assert.equal(hrefForRoute("settings"), "/settings/computers");
    assert.equal(hrefForSettingsSection("skills"), "/settings/skills");
    assert.equal(
      pathForAppState({ route: "settings", mobileView: "chat", sessionId: null, settingsSection: "language" }),
      "/settings/language",
    );
  });

  it("formats clean paths with encoded entity ids", () => {
    assert.equal(pathForAppState({ route: "main", mobileView: "chat", sessionId: "ses/123" }), "/threads/ses%2F123");
    assert.equal(pathForAppState({ route: "main", mobileView: "chat", sessionId: null, composingNew: true }), "/threads/new");
    assert.equal(pathForAppState({ route: "projects", mobileView: "threads", sessionId: null, projectId: "prj/123" }), "/projects/prj%2F123");
    assert.equal(pathForAppState({ route: "projects", mobileView: "chat", sessionId: null, projectId: "prj/123", composingNew: true }), "/projects/prj%2F123/new");
    assert.equal(pathForAppState({ route: "projects", mobileView: "chat", sessionId: "ses/123", projectId: "prj/123" }), "/projects/prj%2F123/threads/ses%2F123");
    assert.equal(pathForAppState({ route: "agents", mobileView: "chat", sessionId: null, agentId: "agent 1" }), "/agents/agent%201");
    assert.equal(pathForAppState({ route: "teams", mobileView: "chat", sessionId: null, teamWorkspaceId: "team 1" }), "/teams/team%201");
    assert.equal(hrefForRoute("main", "ses_123"), "/threads/ses_123");
    assert.equal(hrefForRoute("projects"), "/projects");
    assert.equal(hrefForRoute("backlog"), "/backlog");
    assert.equal(hrefForRoute("routine"), "/routines");
    assert.equal(hrefForRoute("settings"), "/settings/computers");
  });

  it("marks unknown paths as not found instead of opening chat", () => {
    assert.equal(parseAppPath("/missing").notFound, true);
    assert.equal(parseAppPath("/threads/a/b").notFound, true);
  });

  it("accepts only recognized same-origin authentication return paths", () => {
    assert.equal(validatedReturnTo("/threads/ses_1?tab=activity"), "/threads/ses_1");
    assert.equal(validatedReturnTo("https://evil.example/threads"), "/threads");
    assert.equal(validatedReturnTo("//evil.example/threads"), "/threads");
    assert.equal(validatedReturnTo("/missing"), "/threads");
    assert.equal(validatedReturnTo("/login"), "/threads");
  });

  it("keeps only query parameters owned by the route and selected tab", () => {
    assert.equal(
      canonicalBrowserUrl("/agents", "?q=ops&availability=ready&tab=workspace"),
      "/agents?q=ops&availability=ready",
    );
    assert.equal(
      canonicalBrowserUrl("/agents/agent-1", "?q=ops&tab=workspace&scope=shared&path=src&item=file%3Aa.ts"),
      "/agents/agent-1",
    );
    assert.equal(
      canonicalBrowserUrl("/agents/agent-1", "?tab=profile&scope=shared&path=src&item=file%3Aa.ts"),
      "/agents/agent-1",
    );
    assert.equal(
      canonicalBrowserUrl("/teams/team-1", "?tab=profile&artifact=art-1&dialog=create"),
      "/teams/team-1?dialog=create",
    );
    assert.equal(
      canonicalBrowserUrl("/teams/team-1", "?tab=workspace&scope=shared&path=src&item=file%3Aa.ts"),
      "/teams/team-1",
    );
    assert.equal(
      canonicalBrowserUrl("/projects/project-1", "?tab=workspace&scope=shared&path=src&item=file%3Aa.ts"),
      "/projects/project-1?tab=workspace&path=src&item=file%3Aa.ts",
    );
    assert.equal(
      canonicalBrowserUrl("/projects/project-1", "?tab=activities&path=stale&item=file%3Aa.ts"),
      "/projects/project-1",
    );
    assert.equal(canonicalBrowserUrl("/agents/agent-1", "?tab=artifacts&item=artifact%3Aold"), "/agents/agent-1");
    assert.equal(canonicalBrowserUrl("/agents/agent-1", "?tab=activities"), "/agents/agent-1?tab=activities");
    assert.equal(canonicalBrowserUrl("/teams/team-1", "?tab=artifacts&artifact=old"), "/teams/team-1");
    assert.equal(canonicalBrowserUrl("/teams", "?dialog=create&tab=artifacts"), "/teams?dialog=create");
    assert.equal(canonicalBrowserUrl("/backlog", "?bogus=stale"), "/backlog");
  });

  it("round-trips the thread space panel params on thread paths", () => {
    // ?space=1&artifact=<id> survive reload and sharing on an open thread.
    assert.equal(
      canonicalBrowserUrl("/threads/ses-1", "?space=1&artifact=art-9"),
      "/threads/ses-1?space=1&artifact=art-9",
    );
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?space=1"), "/threads/ses-1?space=1");
    // A selection without an open panel is meaningless; so is space=0.
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?artifact=art-9"), "/threads/ses-1");
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?space=0"), "/threads/ses-1");
    // Composing a new thread has no output, and the collection has no panel.
    assert.equal(canonicalBrowserUrl("/threads/new", "?space=1"), "/threads/new");
    assert.equal(
      canonicalBrowserUrl("/projects/prj-1/threads/ses-1", "?space=1&artifact=art-9"),
      "/projects/prj-1/threads/ses-1?space=1&artifact=art-9",
    );
    // The bare list path still shows a thread on desktop, so it owns the
    // panel params too — otherwise the toggle writes them and the canonical
    // URL drops them again, and the button does nothing.
    assert.equal(
      canonicalBrowserUrl("/threads", "?space=1&artifact=art-9"),
      "/threads?space=1&artifact=art-9",
    );
  });

  it("keeps the space panel's own tab on thread paths", () => {
    // Half-addressable state was the bug: ?space=1&artifact= survived reload
    // while the Project / This thread switcher did not, so a project
    // workspace view could not be linked at all.
    assert.equal(
      canonicalBrowserUrl("/threads/ses-1", "?space=1&spaceTab=project"),
      "/threads/ses-1?space=1&spaceTab=project",
    );
    // "thread" is the solo default and never advertises itself, and the tab
    // only means something while the panel is open.
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?space=1&spaceTab=thread"), "/threads/ses-1?space=1");
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?spaceTab=project"), "/threads/ses-1");
    assert.equal(canonicalBrowserUrl("/threads/ses-1", "?space=1&spaceTab=bogus"), "/threads/ses-1?space=1");
  });

  it("keeps the open task record on a project path", () => {
    // A project task opens as a drawer over the project, so the record is
    // addressable without leaving the project the reader came from.
    assert.equal(canonicalBrowserUrl("/projects/project-1", "?task=task-9"), "/projects/project-1?task=task-9");
    assert.equal(
      canonicalBrowserUrl("/projects/project-1", "?tab=tasks&task=task-9"),
      "/projects/project-1?task=task-9",
    );
    // The record lives on the tasks tab; no other tab can show it.
    assert.equal(canonicalBrowserUrl("/projects/project-1", "?tab=profile&task=task-9"), "/projects/project-1?tab=profile");
  });

  it("reports which paths keep the thread space params", () => {
    // A surface that writes ?space=1 on a path that does not own it gets the
    // param canonicalized straight back out, so the toggle does nothing at
    // all — so every path that can show the toggle has to keep them.
    assert.equal(pathKeepsThreadSpaceParams("/threads/ses-1"), true);
    assert.equal(pathKeepsThreadSpaceParams("/threads"), true);
    assert.equal(pathKeepsThreadSpaceParams("/threads/new"), false);
    assert.equal(pathKeepsThreadSpaceParams("/projects/prj-1/threads/ses-1"), true);
    assert.equal(pathKeepsThreadSpaceParams("/backlog"), false);
  });

  it("keeps the sort param on every path whose list has sortable column headers", () => {
    // Same trap as the space panel above: a table that writes ?sort on a path
    // that does not own it has the param canonicalized straight back out, so
    // clicking a column header does nothing at all.
    assert.equal(canonicalBrowserUrl("/backlog", "?sort=-due"), "/backlog?sort=-due");
    assert.equal(canonicalBrowserUrl("/routines", "?sort=title"), "/routines?sort=title");
    // The admin page keeps two tables on one path, so each owns its own key.
    assert.equal(
      canonicalBrowserUrl("/admin", "?employeeSort=-running&nodeSort=node"),
      "/admin?employeeSort=-running&nodeSort=node",
    );
  });

  it("keeps the page param on every path whose list pages", () => {
    // Same trap as ?sort and ?space: unowned params are canonicalized straight
    // back out, so the pager would advance its own highlight and show page 1.
    assert.equal(canonicalBrowserUrl("/backlog", "?page=3"), "/backlog?page=3");
    assert.equal(canonicalBrowserUrl("/routines", "?page=2"), "/routines?page=2");
    assert.equal(canonicalBrowserUrl("/settings/computers", "?page=2"), "/settings/computers?page=2");
    assert.equal(
      canonicalBrowserUrl("/admin", "?employeePage=2&nodePage=4"),
      "/admin?employeePage=2&nodePage=4",
    );
  });

  it("keeps sort and page together, since a reader sets both", () => {
    assert.equal(canonicalBrowserUrl("/backlog", "?sort=-due&page=2"), "/backlog?sort=-due&page=2");
  });

  it("drops a page param that is not a positive integer", () => {
    // parsePageParam would floor these to 1 anyway; dropping them keeps the
    // URL from advertising a page that is not being shown.
    assert.equal(canonicalBrowserUrl("/backlog", "?page=0"), "/backlog");
    assert.equal(canonicalBrowserUrl("/backlog", "?page=-2"), "/backlog");
    assert.equal(canonicalBrowserUrl("/backlog", "?page=nope"), "/backlog");
    assert.equal(canonicalBrowserUrl("/backlog", "?page=1.5"), "/backlog");
    // Page 1 is the default and carries no param.
    assert.equal(canonicalBrowserUrl("/backlog", "?page=1"), "/backlog");
  });

  it("keeps per-group pages on the two paths whose lists group", () => {
    // /backlog groups by task status (board lanes and list bands alike);
    // /routines groups by schedule health. Every other path drops the param.
    assert.equal(canonicalBrowserUrl("/backlog", "?lanes=running:2"), "/backlog?lanes=running%3A2");
    // /routines does NOT group: its section rail carries schedule health, so
    // the board is one flat collection on one cursor and a lane cursor is a
    // param no control on the page can honour.
    assert.equal(canonicalBrowserUrl("/routines", "?lanes=running:2"), "/routines");
    assert.equal(canonicalBrowserUrl("/threads", "?lanes=running:2"), "/threads");
  });

  it("drops a page param on a path with no paged list", () => {
    assert.equal(canonicalBrowserUrl("/threads", "?page=2"), "/threads");
    assert.equal(canonicalBrowserUrl("/backlog", "?nodePage=2"), "/backlog");
  });

  it("drops a sort param on a path with no sortable table", () => {
    assert.equal(canonicalBrowserUrl("/threads", "?sort=-due"), "/threads");
    assert.equal(canonicalBrowserUrl("/backlog", "?nodeSort=node"), "/backlog");
    assert.equal(canonicalBrowserUrl("/admin", "?sort=-due"), "/admin");
  });

  it("keeps the open space panel when a state change stays on the same thread", () => {
    const onThread = {
      route: "main" as const,
      mobileView: "chat" as const,
      sessionId: "ses-1",
      composingNew: false,
    };
    // Sending another turn in the thread re-syncs the same path — the panel
    // must survive it. This is the team-room case: the room accumulates
    // artifacts, and every follow-up message re-syncs the thread URL.
    assert.equal(
      browserUrlForAppState(onThread, "/threads/ses-1", "?space=1&artifact=art-9"),
      "/threads/ses-1?space=1&artifact=art-9",
    );
    // Switching to a different thread drops the previous thread's selection.
    assert.equal(
      browserUrlForAppState(onThread, "/threads/ses-2", "?space=1&artifact=art-9"),
      "/threads/ses-1",
    );
    // Staging a new thread has no artifacts to describe.
    assert.equal(
      browserUrlForAppState(
        { route: "main", mobileView: "chat", sessionId: null, composingNew: true },
        "/threads/ses-1",
        "?space=1",
      ),
      "/threads/new",
    );
    // Params the path does not own are still canonicalized away.
    assert.equal(
      browserUrlForAppState(onThread, "/threads/ses-1", "?artifact=art-9"),
      "/threads/ses-1",
    );
  });

  it("hands the routines record drawer every param the board owns", () => {
    const onBoard = { route: "routine" as const, mobileView: "chat" as const, sessionId: null };
    // Opening a record keeps the list's filters — the list is still showing
    // beneath the drawer.
    assert.equal(
      browserUrlForAppState({ ...onBoard, taskId: "R-42" }, "/routines", "?state=paused&q=digest"),
      "/routines/R-42?q=digest&state=paused",
    );
    // Closing it hands them back; the record's tab stays with the record.
    assert.equal(
      browserUrlForAppState(onBoard, "/routines/R-42", "?state=paused&tab=files"),
      "/routines?state=paused",
    );
    // Routine to one of its runs carries both the tab and the filters.
    assert.equal(
      browserUrlForAppState({ ...onBoard, taskId: "R-42", runId: "T-2288" }, "/routines/R-42", "?state=paused&tab=files"),
      "/routines/R-42/runs/T-2288?tab=files&state=paused",
    );
    // Task records also retain their list filters.
    assert.equal(
      browserUrlForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: "T-1001" }, "/backlog", "?status=blocked"),
      "/backlog/T-1001?status=blocked",
    );
  });
});

it("preserves computer device approval through login redirects", () => {
  const url = "/computer?connect=abcdefghijklmnopqrstuvwxyz123456";
  assert.equal(canonicalBrowserUrl("/computer", "?connect=abcdefghijklmnopqrstuvwxyz123456"), url);
});

it("preserves approval when the legacy computer path redirects to settings", () => {
  assert.equal(browserUrlForAppState(parseAppPath("/computer"), "/computer", "?connect=abcdefghijklmnopqrstuvwxyz123456"), "/settings/computers?connect=abcdefghijklmnopqrstuvwxyz123456");
});

it("keeps the project team tab explicit and canonicalizes Tasks as the default", () => {
  assert.equal(canonicalBrowserUrl("/projects/p", "?tab=profile"), "/projects/p?tab=profile");
  assert.equal(canonicalBrowserUrl("/projects/p", "?tab=tasks"), "/projects/p");
});

it("preserves team, assignment, and upcoming task filters in list and record URLs", () => {
  for (const path of ["/backlog", "/backlog/task-1"]) {
    const url = new URL(canonicalBrowserUrl(path, "?team=team-a&assignment=unassigned&due=next_week"), "http://relay.test");
    assert.equal(url.searchParams.get("team"), "team-a");
    assert.equal(url.searchParams.get("assignment"), "unassigned");
    assert.equal(url.searchParams.get("due"), "next_week");
  }
  assert.equal(canonicalBrowserUrl("/backlog", "?assignment=invalid"), "/backlog");
});
