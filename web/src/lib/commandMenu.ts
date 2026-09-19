import type { AppRoute } from "./viewTypes.js";

/* Command-menu model — the command list and its ranking are pure so the
   palette component stays a thin renderer and the whole catalogue is
   testable without a DOM. */

export type CommandGroup = "navigate" | "create" | "view";

export type CommandId =
  | `go:${AppRoute}`
  | "new-thread"
  | "new-task"
  | "toggle-sidebar"
  | "toggle-theme"
  | "open-preferences"
  | "shortcuts-help";

export type CommandItem = {
  id: CommandId;
  group: CommandGroup;
  label: string;
  /** Chord hint rendered on the right, e.g. "G B" or "⌘K". Already formatted. */
  hint?: string;
  /** Extra match terms (English aliases for localized labels). */
  keywords: string[];
};

const NAV_COMMANDS: readonly { route: AppRoute; labelKey: string; hint: string; keywords: string[] }[] = [
  { route: "main", labelKey: "nav.threads", hint: "G T", keywords: ["threads", "chat", "home"] },
  { route: "projects", labelKey: "project.projects", hint: "G P", keywords: ["projects", "project rooms"] },
  { route: "backlog", labelKey: "nav.backlog", hint: "G B", keywords: ["backlog", "tasks", "board"] },
  { route: "routine", labelKey: "nav.routine", hint: "G R", keywords: ["routines", "schedule"] },
  { route: "agents", labelKey: "nav.agents", hint: "G A", keywords: ["agents", "workforce"] },
  { route: "teams", labelKey: "nav.teams", hint: "G E", keywords: ["teams"] },
  { route: "channels", labelKey: "nav.channels", hint: "G H", keywords: ["channels", "integrations"] },
  // One destination, and the section names stay searchable: a reader looking
  // for "skills" or "my computers" finds Settings, which opens on them.
  { route: "settings", labelKey: "nav.settings", hint: "G S", keywords: ["settings", "preferences", "appearance", "theme", "language", "skills", "computer", "machines"] },
  { route: "admin", labelKey: "nav.admin", hint: "G D", keywords: ["admin", "dashboard"] },
];

export function buildCommands({
  isAdmin,
  t,
}: {
  isAdmin: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}): CommandItem[] {
  const navigate = NAV_COMMANDS
    .filter(({ route }) => route !== "admin" || isAdmin)
    .map(({ route, labelKey, hint, keywords }): CommandItem => ({
      id: `go:${route}`,
      group: "navigate",
      label: t("command.go_to", { name: t(labelKey) }),
      hint,
      keywords: [...keywords, t(labelKey).toLowerCase()],
    }));
  return [
    ...navigate,
    {
      id: "new-thread",
      group: "create",
      label: t("thread.new_thread"),
      hint: "N",
      keywords: ["new", "thread", "compose", "conversation"],
    },
    {
      id: "new-task",
      group: "create",
      label: t("backlog.new_task"),
      hint: "C",
      keywords: ["new", "task", "create"],
    },
    {
      id: "toggle-sidebar",
      group: "view",
      label: t("command.toggle_sidebar"),
      keywords: ["sidebar", "sidenav", "collapse", "expand"],
    },
    {
      id: "toggle-theme",
      group: "view",
      label: t("command.toggle_theme"),
      keywords: ["theme", "dark", "light", "appearance"],
    },
    {
      id: "open-preferences",
      group: "view",
      label: t("command.open_preferences"),
      keywords: ["preferences", "settings"],
    },
    {
      id: "shortcuts-help",
      group: "view",
      label: t("command.shortcuts_help"),
      hint: "?",
      keywords: ["keyboard", "shortcuts", "help", "keys"],
    },
  ];
}

/**
 * Substring ranking, deliberately not fuzzy: exact label first, then label
 * prefix, then label substring, then keyword substring. Predictable beats
 * clever for an operator tool — the same query always yields the same order.
 */
export function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  const scored = commands.flatMap((command) => {
    const label = command.label.toLowerCase();
    if (label === needle) return [{ command, rank: 0 }];
    if (label.startsWith(needle)) return [{ command, rank: 1 }];
    if (label.includes(needle)) return [{ command, rank: 2 }];
    if (command.keywords.some((keyword) => keyword.toLowerCase().includes(needle))) {
      return [{ command, rank: 3 }];
    }
    return [];
  });
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ command }) => command);
}
