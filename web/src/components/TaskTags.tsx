import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tagKey, tagTone } from "../lib/taskTags";
import { TagFilterContext, type TagFilter } from "./tagFilter";

/**
 * A tag's colour, alone: the "#" every tag badge leads with, and the mark
 * beside a tag in the filter menu. Its tone comes from the tag's name
 * (`tagTone`), so one tag is one colour everywhere. The glyph is drawn by CSS
 * and hidden from assistive tech, which reads the tag's name alone.
 */
export function TagMark({ tag }: { tag: string }) {
  return <span className="tag-mark" data-tone={tagTone(tag)} aria-hidden="true" />;
}

/**
 * The ONE tag badge: the tag's toned "#" and its name, in ink, on the shared
 * chip fill.
 *
 * Deliberately not a toned Badge. Badges are status — a toned word on a toned
 * fill (done, blocked, needs project); a tag is a label the person chose and
 * means nothing to Relay, so its name stays ink and its colour stays in the
 * "#", which also says what the chip is without a legend. `children` is a
 * trailing control — the editor's remove button.
 */
export function TagBadge({ tag, className, children }: { tag: string; className?: string; children?: ReactNode }) {
  return (
    <span className={cn("tag-badge", className)} title={tag}>
      <TagMark tag={tag} />
      <span className="tag-badge-text">{tag}</span>
      {children}
    </span>
  );
}

/**
 * One tag as a toggle on its list's filter: the same badge, pressed while the
 * list is filtered on it. A click must not also reach the row or tile the
 * tag sits in, which would open the task instead.
 */
function TagToggle({ tag, filter }: { tag: string; filter: TagFilter }) {
  const { t } = useTranslation();
  const pressed = filter.active !== "all" && tagKey(filter.active) === tagKey(tag);
  return (
    <button
      type="button"
      className="tag-badge tag-badge--toggle"
      aria-pressed={pressed}
      aria-label={t(pressed ? "tags.filter_clear" : "tags.filter_by", { tag })}
      title={t(pressed ? "tags.filter_clear" : "tags.filter_by", { tag })}
      onClick={(event) => {
        event.stopPropagation();
        filter.onSelect(pressed ? "all" : tag);
      }}
    >
      <TagMark tag={tag} />
      <span className="tag-badge-text">{tag}</span>
    </button>
  );
}

/**
 * A task's tags. Rows pass `max` so a heavily tagged task cannot push the
 * row's other columns out; the rest collapse into "+N", whose tooltip names
 * them. Under a `TagFilterContext` each tag is a toggle on that list's
 * filter, and the tag being filtered on is drawn first so a row never hides
 * the reason it matched inside "+N".
 */
export function TaskTagList({ tags, max, className }: { tags?: readonly string[]; max?: number; className?: string }) {
  const { t } = useTranslation();
  const filter = useContext(TagFilterContext);
  if (!tags?.length) return null;
  const ordered = filter && filter.active !== "all" ? leadWithTag(tags, filter.active) : tags;
  const shown = max === undefined ? ordered : ordered.slice(0, max);
  const hidden = ordered.slice(shown.length);
  return (
    <ul className={cn("tag-list", className)} aria-label={t("tags.label")}>
      {shown.map((tag) => (
        <li key={tag}>{filter ? <TagToggle tag={tag} filter={filter} /> : <TagBadge tag={tag} />}</li>
      ))}
      {hidden.length ? (
        <li>
          <Tooltip content={hidden.join(", ")}>
            <span className="tag-badge tag-badge--more" tabIndex={0} aria-label={t("tags.more_label", { count: hidden.length, tags: hidden.join(", ") })}>
              {t("tags.more", { count: hidden.length })}
            </span>
          </Tooltip>
        </li>
      ) : null}
    </ul>
  );
}

/** `tags` with `lead` (compared case-insensitively) moved to the front. */
function leadWithTag(tags: readonly string[], lead: string): readonly string[] {
  const key = tagKey(lead);
  const index = tags.findIndex((tag) => tagKey(tag) === key);
  return index <= 0 ? tags : [tags[index], ...tags.slice(0, index), ...tags.slice(index + 1)];
}
