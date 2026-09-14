import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandShortcutLabel,
  createShortcutResolver,
  GO_SHORTCUTS,
  isEditableTarget,
  isCommandMenuChord,
} from "../src/lib/shortcuts.js";

function key(value: string, extras: Record<string, unknown> = {}) {
  return { key: value, ...extras } as Parameters<ReturnType<typeof createShortcutResolver>>[0];
}

function editable(tagName: string, type?: string) {
  return { tagName, type } as unknown as EventTarget;
}

describe("isEditableTarget", () => {
  it("treats text-entry surfaces as editable", () => {
    assert.equal(isEditableTarget(editable("INPUT", "text")), true);
    assert.equal(isEditableTarget(editable("INPUT")), true);
    assert.equal(isEditableTarget(editable("TEXTAREA")), true);
    assert.equal(isEditableTarget(editable("SELECT")), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
  });

  it("treats chrome and non-text inputs as not editable", () => {
    assert.equal(isEditableTarget(editable("BUTTON")), false);
    assert.equal(isEditableTarget(editable("A")), false);
    assert.equal(isEditableTarget(editable("INPUT", "checkbox")), false);
    assert.equal(isEditableTarget(editable("INPUT", "range")), false);
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget({} as EventTarget), false);
  });
});

describe("isCommandMenuChord", () => {
  it("accepts ⌘K and Ctrl+K without other modifiers", () => {
    assert.equal(isCommandMenuChord(key("k", { metaKey: true })), true);
    assert.equal(isCommandMenuChord(key("K", { ctrlKey: true })), true);
    assert.equal(isCommandMenuChord(key("k", { metaKey: true, shiftKey: true })), false);
    assert.equal(isCommandMenuChord(key("k", { metaKey: true, altKey: true })), false);
    assert.equal(isCommandMenuChord(key("k")), false);
  });
});

describe("commandShortcutLabel", () => {
  it("is platform-aware", () => {
    assert.equal(commandShortcutLabel("MacIntel"), "⌘K");
    assert.equal(commandShortcutLabel("Win32"), "Ctrl+K");
    assert.equal(commandShortcutLabel("Linux x86_64"), "Ctrl+K");
  });
});

describe("shortcut resolver", () => {
  it("fires the command-menu chord from any target, even a text field", () => {
    const resolve = createShortcutResolver({ isAdmin: false });
    assert.deepEqual(resolve(key("k", { metaKey: true, target: editable("INPUT") })), { kind: "command-menu" });
  });

  it("opens the shortcuts help on ?", () => {
    const resolve = createShortcutResolver({ isAdmin: false });
    assert.deepEqual(resolve(key("?", { shiftKey: true })), { kind: "shortcuts-help" });
  });

  it("resolves g-prefixed go-to chords inside the timeout", () => {
    let now = 1000;
    const resolve = createShortcutResolver({ isAdmin: true, now: () => now });
    assert.equal(resolve(key("g")), null); // arms the prefix
    assert.deepEqual(resolve(key("b")), { kind: "go", route: "backlog" });
    resolve(key("g"));
    assert.deepEqual(resolve(key("T", { shiftKey: true })), { kind: "go", route: "main" });
  });

  it("expires the g prefix after the timeout", () => {
    let now = 1000;
    const resolve = createShortcutResolver({ isAdmin: true, now: () => now });
    resolve(key("g"));
    now += 2000;
    assert.equal(resolve(key("b")), null);
  });

  it("ignores unknown go-to letters and double-g", () => {
    const resolve = createShortcutResolver({ isAdmin: true });
    resolve(key("g"));
    assert.equal(resolve(key("z")), null);
    resolve(key("g"));
    assert.equal(resolve(key("g")), null);
    // …and the prefix is disarmed: a following letter is a bare chord.
    assert.deepEqual(resolve(key("c")), { kind: "new-task" });
  });

  it("gates the admin route", () => {
    const resolve = createShortcutResolver({ isAdmin: false });
    resolve(key("g"));
    assert.equal(resolve(key("d")), null);
    const adminResolve = createShortcutResolver({ isAdmin: true });
    adminResolve(key("g"));
    assert.deepEqual(adminResolve(key("d")), { kind: "go", route: "admin" });
  });

  it("maps creation chords", () => {
    const resolve = createShortcutResolver({ isAdmin: false });
    assert.deepEqual(resolve(key("c")), { kind: "new-task" });
    assert.deepEqual(resolve(key("n")), { kind: "new-thread" });
  });

  it("never fires from editable targets, and disarms a pending g", () => {
    const resolve = createShortcutResolver({ isAdmin: true });
    assert.equal(resolve(key("c", { target: editable("INPUT") })), null);
    assert.equal(resolve(key("g")), null);
    assert.equal(resolve(key("b", { target: editable("TEXTAREA") })), null);
    // The editable keystroke disarmed the prefix, so the next bare letter is
    // not a go-to — and "b" alone is not a chord.
    assert.equal(resolve(key("b")), null);
  });

  it("ignores modified and prevented events", () => {
    const resolve = createShortcutResolver({ isAdmin: true });
    assert.equal(resolve(key("c", { ctrlKey: true })), null);
    assert.equal(resolve(key("c", { altKey: true })), null);
    assert.equal(resolve(key("c", { defaultPrevented: true })), null);
  });

  it("keeps every go-to letter mapped to a distinct route", () => {
    const routes = Object.values(GO_SHORTCUTS);
    assert.equal(new Set(routes).size, routes.length);
    assert.deepEqual([...routes].sort(), ["admin", "agents", "backlog", "channels", "computer", "main", "projects", "routine", "skills", "teams"]);
  });
});
