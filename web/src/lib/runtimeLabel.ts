/** Product names whose casing a first-letter capital gets wrong. */
const RUNTIME_LABELS: Readonly<Record<string, string>> = { opencode: "OpenCode", antigravity: "Google Antigravity" };

/**
 * The display name of a runtime (executor kind). Runtime names are proper
 * nouns, so they are never translated; the one table above holds the names a
 * first-letter capital would misspell. Every surface that names a runtime by
 * kind reads it here, so a product name is spelled the same everywhere.
 */
export function runtimeLabel(kind: string): string {
  return RUNTIME_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}
