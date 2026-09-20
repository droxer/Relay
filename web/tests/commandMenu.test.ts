import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCommands, filterCommands, type CommandItem } from "../src/lib/commandMenu.js";

const LABELS: Record<string, string> = {
  "nav.threads": "Threads",
  "project.projects": "Projects",
  "nav.backlog": "Backlog",
  "nav.routine": "Routines",
  "nav.agents": "Agents",
  "nav.teams": "Teams",
  "nav.settings": "Settings",
  "nav.channels": "Channels",
  "nav.admin": "Admin",
  "thread.new_thread": "New thread",
  "backlog.new_task": "New task",
  "command.go_to": "Go to {{name}}",
  "command.toggle_sidebar": "Toggle sidebar",
  "command.toggle_theme": "Switch theme",
  "command.open_preferences": "Open preferences",
  "command.shortcuts_help": "Keyboard shortcuts",
};

function fakeT(key: string, options?: Record<string, unknown>): string {
  const template = LABELS[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ""));
}

const adminCommands = buildCommands({ isAdmin: true, t: fakeT });
const userCommands = buildCommands({ isAdmin: false, t: fakeT });

describe("buildCommands", () => {
  it("gates the admin destination", () => {
    assert.ok(adminCommands.some((command) => command.id === "go:admin"));
    assert.ok(!userCommands.some((command) => command.id === "go:admin"));
    assert.ok(!userCommands.some((command) => command.label.includes("Admin")));
  });

  it("offers every navigation destination with its go-to hint", () => {
    const navigate = userCommands.filter((command) => command.group === "navigate");
    assert.deepEqual(
      navigate.map((command) => command.id),
      ["go:main", "go:backlog", "go:routine", "go:agents", "go:teams", "go:channels", "go:settings"],
    );
    for (const command of navigate) {
      assert.match(command.hint ?? "", /^G [A-Z]$/, `${command.id} lost its go-to hint`);
    }
  });

  it("labels destinations through the nav translations", () => {
    const backlog = userCommands.find((command) => command.id === "go:backlog");
    assert.equal(backlog?.label, "Go to Backlog");
  });

  it("includes creation and view commands", () => {
    for (const id of ["new-thread", "new-task", "toggle-sidebar", "toggle-theme", "open-preferences", "shortcuts-help"]) {
      assert.ok(userCommands.some((command) => command.id === id), `missing ${id}`);
    }
  });
});

describe("filterCommands", () => {
  it("returns the full catalogue in group order for an empty query", () => {
    const result = filterCommands(adminCommands, "   ");
    assert.equal(result.length, adminCommands.length);
    assert.equal(result[0].group, "navigate");
    assert.equal(result.at(-1)?.group, "view");
  });

  it("ranks exact, prefix, substring, then keyword matches", () => {
    const commands: CommandItem[] = [
      { id: "new-task", group: "create", label: "Teams", keywords: [] },
      { id: "new-thread", group: "create", label: "Teamsync", keywords: [] },
      { id: "go:teams", group: "navigate", label: "Go to Teams", keywords: [] },
      { id: "toggle-theme", group: "view", label: "Appearance", keywords: ["theme", "teams"] },
    ];
    const result = filterCommands(commands, "teams");
    assert.deepEqual(
      result.map((command) => command.id),
      ["new-task", "new-thread", "go:teams", "toggle-theme"],
    );
  });

  it("matches case-insensitively against localized labels and keywords", () => {
    assert.deepEqual(filterCommands(userCommands, "BACKLOG").map((c) => c.id), ["go:backlog"]);
    // "schedule" is an English keyword for the localized Routines label.
    assert.deepEqual(filterCommands(userCommands, "schedule").map((c) => c.id), ["go:routine"]);
  });

  it("drops non-matches entirely", () => {
    assert.deepEqual(filterCommands(adminCommands, "zzzz-nothing"), []);
  });
});
