/**
 * Task tags: free-form labels for filing tasks and automations.
 *
 * Mirrors `backend/relay/core/task_tags.py`: a tag is trimmed with its inner
 * whitespace collapsed, at most MAX_TAG_CHARS long, never contains a comma
 * (the separator people type), and two tags differing only by case are one
 * tag — the first spelling wins. A task carries at most MAX_TAGS.
 */

export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 32;

/** One tag in its stored spelling, or null when it cannot be a tag. */
export function normalizeTag(value: string): string | null {
  const tag = value.split(/\s+/).filter(Boolean).join(" ");
  if (!tag || tag.length > MAX_TAG_CHARS || tag.includes(",")) return null;
  if (/[\u0000-\u001f\u007f]/.test(tag)) return null;
  return tag;
}

export function tagKey(tag: string): string {
  return tag.toLocaleLowerCase();
}

export function hasTag(tags: readonly string[] | undefined, tag: string): boolean {
  const key = tagKey(tag);
  return (tags ?? []).some((item) => tagKey(item) === key);
}

/**
 * `tags` with whatever `input` names added — split on commas, each piece
 * normalized, duplicates and invalid pieces dropped, capped at MAX_TAGS.
 */
export function addTags(tags: readonly string[], input: string): string[] {
  const next = [...tags];
  for (const piece of input.split(",")) {
    const tag = normalizeTag(piece);
    if (!tag || hasTag(next, tag) || next.length >= MAX_TAGS) continue;
    next.push(tag);
  }
  return next;
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return tags.filter((item) => tagKey(item) !== key);
}

export function tagsEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/** Every tag the given tasks carry, once each, in alphabetical order. */
export function collectTags(tasks: ReadonlyArray<{ tags?: string[] }>): string[] {
  const byKey = new Map<string, string>();
  for (const task of tasks) {
    for (const tag of task.tags ?? []) {
      if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The tag filter: `all` passes everything; otherwise the task must carry it. */
export function matchesTagFilter(task: { tags?: string[] }, filter: string): boolean {
  return filter === "all" || !filter || hasTag(task.tags, filter);
}
