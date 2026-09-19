export type MobileView = "threads" | "chat";
export type AppRoute = "main" | "projects" | "backlog" | "routine" | "agents" | "teams" | "settings" | "channels" | "admin";

/* Personal settings sections. Computers and Skills used to be top-level
   routes of their own; they are sections of one Settings surface now, beside
   appearance and language — the same rail-of-sections shape the control panel
   uses. Adding a section = one entry here plus its case in SettingsPage. */
export type SettingsSection = "computers" | "skills" | "appearance" | "language";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "computers",
  "skills",
  "appearance",
  "language",
];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "computers";

export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}
