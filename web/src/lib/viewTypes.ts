export type MobileView = "threads" | "chat";
export type AppRoute = "main" | "projects" | "backlog" | "routine" | "agents" | "teams" | "computers" | "skills" | "settings" | "channels" | "admin";

/* Personal settings sections: what the app tells a person about, and how it
   looks and speaks — the same rail-of-sections shape the control panel uses.
   Computers and Skills are not here: they are the Infra a person runs agents
   on, so they are top-level routes of their own (`/computers`, `/skills`).
   Adding a section = one entry here plus its case in SettingsPage. */
export type SettingsSection = "notifications" | "appearance" | "language";

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "notifications",
  "appearance",
  "language",
];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "notifications";

export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/* Control-panel sections. Like the settings sections above, these are
   destinations rather than views of one page — each has its own address
   (`/admin/<section>`), so a reload or a shared link lands where it left off.
   The id IS the URL segment: one spelling per section, no id→slug map to
   drift. Adding a section = one entry here plus its case in AdminPage. */
export type AdminSection = "dashboard" | "users" | "computers" | "waitlist" | "organization";

const ADMIN_SECTIONS: readonly AdminSection[] = [
  "dashboard",
  "users",
  "computers",
  "waitlist",
  "organization",
];

export const DEFAULT_ADMIN_SECTION: AdminSection = "dashboard";

export function isAdminSection(value: string | null | undefined): value is AdminSection {
  return typeof value === "string" && (ADMIN_SECTIONS as readonly string[]).includes(value);
}
