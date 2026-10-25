import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tagTone } from "../lib/taskTags";

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
 * A task's tags as read-only badges. Rows pass `max` so a heavily tagged task
 * cannot push the row's other columns out; the rest collapse into "+N",
 * whose tooltip names them.
 */
export function TaskTagList({ tags, max, className }: { tags?: readonly string[]; max?: number; className?: string }) {
  const { t } = useTranslation();
  if (!tags?.length) return null;
  const shown = max === undefined ? tags : tags.slice(0, max);
  const hidden = tags.slice(shown.length);
  return (
    <ul className={cn("tag-list", className)} aria-label={t("tags.label")}>
      {shown.map((tag) => (
        <li key={tag}><TagBadge tag={tag} /></li>
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
