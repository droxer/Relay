export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<Theme, "system">;

export const SUPPORTED_THEMES = ["light", "dark", "system"] as const;

export const SUPPORTED_LANGUAGES = ["en", "zh-CN", "zh-TW"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export type TokenMap = Record<string, string>;

export const tokenStorageKey = "relay-web.tokens";
export const selectedEmployeeKey = "relay-web.selectedEmployee";
export const themeStorageKey = "relay-web.theme";
export const languageStorageKey = "relay-web.language";
export const threadSpaceWidthKey = "relay-web.threadSpaceWidth";
export const threadListWidthKey = "relay-web.threadListWidth";
export const sidenavWidthKey = "relay-web.sidenavWidth";
export const sidenavExpandedKey = "relay-web.sidenavExpanded";
export const threadListBesideSpaceKey = "relay-web.threadListBesideSpace";
export const filtersExpandedKeyPrefix = "relay-web.filtersExpanded.";
export const drawerWidthKeyPrefix = "relay-web.drawerWidth.";

export function readTokens(): TokenMap {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(tokenStorageKey) ?? "null") as TokenMap ?? {}; }
  catch { return {}; }
}

export function writeTokens(tokens: TokenMap): void {
  if (typeof window !== "undefined") localStorage.setItem(tokenStorageKey, JSON.stringify(tokens));
}

export function readTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(themeStorageKey);
  if (stored === "contrast" || stored === "contrast-dark") {
    localStorage.setItem(themeStorageKey, "system");
    return "system";
  }
  return SUPPORTED_THEMES.includes(stored as Theme) ? stored as Theme : "system";
}

export function readLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(languageStorageKey);
  return SUPPORTED_LANGUAGES.includes(stored as Language) ? stored as Language : "en";
}

export function writeTheme(theme: Theme): void {
  if (typeof window !== "undefined") localStorage.setItem(themeStorageKey, theme);
}

export function writeLanguage(language: Language): void {
  if (typeof window !== "undefined") localStorage.setItem(languageStorageKey, language);
}

/* ── Shell layout ──────────────────────────────────────────────────────────
   Panel widths and the rail's expanded flag survive reloads. Layout is a
   convenience, never load-bearing: every read falls back to the default and
   every write is dropped when storage is missing or throws (private mode,
   blocked site data, quota), so a broken store cannot break the shell. */

function readLayoutValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function writeLayoutValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, value); }
  catch { /* storage unavailable — the default applies next load */ }
}

/** A stored px width, or null when never resized or unreadable. */
function readLayoutWidth(key: string): number | null {
  const raw = readLayoutValue(key);
  if (raw === null) return null;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/** A stored flag; anything but "true" (including nothing) reads as false. */
function readLayoutFlag(key: string): boolean {
  return readLayoutValue(key) === "true";
}

function writeLayoutFlag(key: string, value: boolean): void {
  writeLayoutValue(key, value ? "true" : "false");
}

/** Whether the side rail was left expanded. Defaults to collapsed. */
export function readSidenavExpanded(): boolean {
  return readLayoutFlag(sidenavExpandedKey);
}

export function writeSidenavExpanded(expanded: boolean): void {
  writeLayoutFlag(sidenavExpandedKey, expanded);
}

/** Whether the user keeps the thread list open beside the thread space
 *  panel. Defaults to false: opening the panel hides the list to make room. */
export function readThreadListBesideSpace(): boolean {
  return readLayoutFlag(threadListBesideSpaceKey);
}

export function writeThreadListBesideSpace(visible: boolean): void {
  writeLayoutFlag(threadListBesideSpaceKey, visible);
}

/** Whether a page's filters bar was left expanded, keyed by the page's
 *  search field name so each page remembers its own. Defaults to collapsed. */
export function readFiltersExpanded(scope: string, fallback = false): boolean {
  const stored = readLayoutValue(filtersExpandedKeyPrefix + scope);
  return stored === null ? fallback : stored === "true";
}

export function writeFiltersExpanded(scope: string, expanded: boolean): void {
  writeLayoutFlag(filtersExpandedKeyPrefix + scope, expanded);
}

/** Dragged expanded-rail width in px, or null when never resized. Kept
 *  separate from the expanded flag: the rail remembers how wide the user
 *  made it across collapse/expand cycles. */
export function readSidenavWidth(): number | null {
  return readLayoutWidth(sidenavWidthKey);
}

export function writeSidenavWidth(width: number): void {
  writeLayoutValue(sidenavWidthKey, String(width));
}

/** Dragged thread-space panel width in px, or null when never resized. */
export function readThreadSpaceWidth(): number | null {
  return readLayoutWidth(threadSpaceWidthKey);
}

export function writeThreadSpaceWidth(width: number): void {
  writeLayoutValue(threadSpaceWidthKey, String(width));
}

/** Dragged thread-list panel width in px, or null when never resized. */
export function readThreadListWidth(): number | null {
  return readLayoutWidth(threadListWidthKey);
}

export function writeThreadListWidth(width: number): void {
  writeLayoutValue(threadListWidthKey, String(width));
}

/** Dragged drawer width in px, keyed by the drawer's width role so all
 *  drawers sharing a role (every task record, every form) open at the width
 *  the user last chose. Null when that role was never resized. */
export function readDrawerWidth(role: string): number | null {
  return readLayoutWidth(drawerWidthKeyPrefix + role);
}

export function writeDrawerWidth(role: string, width: number): void {
  writeLayoutValue(drawerWidthKeyPrefix + role, String(width));
}

/** Resolve the OS color-scheme preference; defaults to light off-DOM. */
export function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

export function syncThemeColor(): void {
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || !document.head
    || typeof document.createElement !== "function"
    || typeof window.getComputedStyle !== "function"
  ) return;
  const canvas = window.getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim();
  if (!canvas) return;
  const query = typeof document.querySelector === "function" ? document.querySelector.bind(document) : null;
  let meta = query?.('meta[name="theme-color"][data-relay-theme-color]') as HTMLMetaElement | null | undefined;
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("data-relay-theme-color", "");
    document.head.appendChild(meta);
  }
  meta.removeAttribute("media");
  meta.setAttribute("content", canvas);
}

/** Reflect the user's choice onto data-theme, resolving "system" to a
 *  concrete value so the CSS needs only html[data-theme] blocks (no
 *  parallel prefers-color-scheme media query). */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
  syncThemeColor();
}
