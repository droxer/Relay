import type { FilterBarField } from "../FiltersBar";
import { hasTag } from "../../lib/taskTags";

/**
 * The filter bar's tag field, shared by the task and automation boards: one
 * choice per tag in use, so the menu never offers a tag that matches nothing.
 * A tag filtered on from a link is kept as a choice even when no task carries
 * it any more, so its chip still renders and can be removed. Null when there
 * is nothing to offer.
 */
export function tagFilterField(tags: readonly string[], active: string, label: string): FilterBarField | null {
  const choices = active !== "all" && active && !hasTag(tags, active) ? [...tags, active] : tags;
  if (!choices.length) return null;
  return { id: "tag", label, kind: "select", options: choices.map((tag) => ({ value: tag, label: tag })) };
}
