/**
 * Pure helpers for the personal tag catalog (Settings → Tags) and the tag
 * pickers that offer its names. Identity follows `taskTags.ts`: two names
 * differing only by case are one tag.
 */

import { tagKey } from "./taskTags.ts";

/** Entries whose name contains `query`, case-insensitively — the server's
 *  `?query=` rule, applied to the already-loaded catalog so typing never
 *  waits on a request. */
export function filterTagEntries<T extends { name: string }>(entries: readonly T[], query: string): T[] {
  const needle = tagKey(query.trim());
  if (!needle) return [...entries];
  return entries.filter((entry) => tagKey(entry.name).includes(needle));
}

/** Every name from the lists once (first spelling wins), alphabetical. A
 *  picker offers the page's tags plus every saved one, used or not. */
export function mergeTagNames(...lists: ReadonlyArray<readonly string[]>): string[] {
  const byKey = new Map<string, string>();
  for (const list of lists) {
    for (const name of list) {
      if (!byKey.has(tagKey(name))) byKey.set(tagKey(name), name);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The error codes the catalog routes answer with (`{ detail: code }`). */
export const TAG_ERROR_CODES = [
  "tag_invalid",
  "tag_operation_invalid",
  "tag_unchanged",
  "tag_not_found",
  "tag_exists",
  "tag_catalog_full",
  "tag_preview_required",
  "tag_preview_stale",
] as const;

/** The i18n key that explains `code`; anything else (network, 5xx) gets the
 *  generic retry message. */
export function tagErrorKey(code: string | undefined): string {
  return code && (TAG_ERROR_CODES as readonly string[]).includes(code)
    ? `tags.manager.error.${code}`
    : "tags.manager.error.generic";
}
