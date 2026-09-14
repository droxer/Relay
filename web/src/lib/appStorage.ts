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

/** Dragged expanded-rail width in px, or null when never resized. Kept
 *  separate from the collapse flag: the rail remembers how wide the user
 *  made it across collapse/expand cycles. */
export function readSidenavWidth(): number | null {
  if (typeof window === "undefined") return null;
  const stored = Number(localStorage.getItem(sidenavWidthKey));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function writeSidenavWidth(width: number): void {
  if (typeof window !== "undefined") localStorage.setItem(sidenavWidthKey, String(width));
}

/** Dragged thread-space panel width in px, or null when never resized. */
export function readThreadSpaceWidth(): number | null {
  if (typeof window === "undefined") return null;
  const stored = Number(localStorage.getItem(threadSpaceWidthKey));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function writeThreadSpaceWidth(width: number): void {
  if (typeof window !== "undefined") localStorage.setItem(threadSpaceWidthKey, String(width));
}

/** Dragged thread-list panel width in px, or null when never resized. */
export function readThreadListWidth(): number | null {
  if (typeof window === "undefined") return null;
  const stored = Number(localStorage.getItem(threadListWidthKey));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function writeThreadListWidth(width: number): void {
  if (typeof window !== "undefined") localStorage.setItem(threadListWidthKey, String(width));
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
