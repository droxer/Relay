import type { AppRoute } from "./viewTypes.js";

/* Keyboard shortcut model — pure, so the whole matrix is unit-testable without
   a DOM. The React layer (useGlobalShortcuts) only translates KeyboardEvents
   into ShortcutEventShape and checks whether a modal owns the screen. */

export type ShortcutAction =
  | { kind: "command-menu" }
  | { kind: "shortcuts-help" }
  | { kind: "go"; route: AppRoute }
  | { kind: "new-thread" }
  | { kind: "new-task" };

export type ShortcutEventShape = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
};

/* Go-to chords. The letter mnemonic bends where a route's initial is taken:
   threads owns T, projects owns P, so teams takes E; channels takes H; admin takes D
   (dashboard). Settings takes S — its computers and skills sections are the
   chords `s` and `c` used to reach, and both are one click away inside it. */
export const GO_SHORTCUTS: Readonly<Record<string, AppRoute>> = {
  t: "main",
  p: "projects",
  b: "backlog",
  r: "routine",
  a: "agents",
  e: "teams",
  s: "settings",
  h: "channels",
  d: "admin",
};

export const GO_PREFIX_TIMEOUT_MS = 900;

/** True when keystrokes belong to the element, not the app: text fields,
 *  selects, and rich-text surfaces. Buttons and links are NOT editable —
 *  a focused nav button must not swallow `g b`. Structural rather than
 *  `instanceof HTMLElement` so the matrix is testable without a DOM. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = typeof el.type === "string" ? el.type : "text";
  // Non-text inputs (checkbox, radio, range, button…) take arrow/space input
  // but single letters mean nothing to them.
  return !["checkbox", "radio", "range", "button", "submit", "reset", "file", "color"].includes(type);
}

export function isCommandMenuChord(event: ShortcutEventShape): boolean {
  return (event.metaKey === true || event.ctrlKey === true)
    && event.altKey !== true
    && event.shiftKey !== true
    && event.key.toLowerCase() === "k";
}

/** Platform-aware label for the command-menu chord. */
export function commandShortcutLabel(platform?: string): string {
  const value = platform ?? (typeof navigator === "undefined" ? "Mac" : navigator.platform);
  return /Mac|iPhone|iPad|iPod/i.test(value) ? "⌘K" : "Ctrl+K";
}

export type ShortcutResolver = (event: ShortcutEventShape) => ShortcutAction | null;

/**
 * Stateful resolver — the `g` prefix arms a go-to chord for GO_PREFIX_TIMEOUT_MS.
 * Editable targets, modified keys (other than ⌘K/Ctrl+K), and prevented events
 * are never shortcuts. `admin` chords resolve only when isAdmin is set; the
 * bare `c`/`n` creation chords never fire for anyone while typing.
 */
export function createShortcutResolver({
  isAdmin,
  now = () => Date.now(),
  goTimeoutMs = GO_PREFIX_TIMEOUT_MS,
}: {
  isAdmin: boolean;
  now?: () => number;
  goTimeoutMs?: number;
}): ShortcutResolver {
  let goArmedAt: number | null = null;

  return (event) => {
    if (event.defaultPrevented) return null;

    if (isCommandMenuChord(event)) {
      goArmedAt = null;
      return { kind: "command-menu" };
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      goArmedAt = null;
      return null;
    }
    if (isEditableTarget(event.target ?? null)) {
      goArmedAt = null;
      return null;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (goArmedAt !== null) {
      const expired = now() - goArmedAt > goTimeoutMs;
      goArmedAt = null;
      if (expired) return null;
      if (key === "g") return null; // "g g" is not a route; stay silent.
      const route = GO_SHORTCUTS[key];
      if (!route) return null;
      if (route === "admin" && !isAdmin) return null;
      return { kind: "go", route };
    }

    if (key === "g" && !event.shiftKey) {
      goArmedAt = now();
      return null;
    }
    if (event.key === "?") return { kind: "shortcuts-help" };
    if (key === "c" && !event.shiftKey) return { kind: "new-task" };
    if (key === "n" && !event.shiftKey) return { kind: "new-thread" };
    return null;
  };
}
