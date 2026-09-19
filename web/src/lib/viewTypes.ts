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

/* Control-panel sections. Like the settings sections above, these are
   destinations rather than views of one page — each has its own address
   (`/admin/<section>`), so a reload or a shared link lands where it left off.
   The id IS the URL segment: one spelling per section, no id→slug map to
   drift. Adding a section = one entry here plus its case in AdminPage. */
export type AdminSection = "dashboard" | "employees" | "computers" | "organization";

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  "dashboard",
  "employees",
  "computers",
  "organization",
];

export const DEFAULT_ADMIN_SECTION: AdminSection = "dashboard";

export function isAdminSection(value: string | null | undefined): value is AdminSection {
  return typeof value === "string" && (ADMIN_SECTIONS as readonly string[]).includes(value);
}
