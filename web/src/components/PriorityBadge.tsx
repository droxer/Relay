import { useTranslation } from "react-i18next";
import type { TaskPriority } from "../types";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Priority is a rank, not a status — so it gets its own glyph: three ascending
 * signal bars filled to the level (low = 1, normal = 2, high = 3). Only `high`
 * takes a colour (warn — a rank, never failure severity).
 *
 * This is the ONE priority mark. It used to be drawn three ways — bare bars in
 * the issue table, a bordered "High" chip on board cards, and bordered chips in
 * the automations table — so the same attribute looked like a different thing
 * on every surface. The word now lives in the tooltip and the accessibility
 * tree; what the eye scans is the same 11px glyph everywhere.
 */
export function PriorityGlyph({ priority }: { priority: TaskPriority }) {
  return (
    <span className="priority-glyph" data-priority={priority} aria-hidden="true">
      <span className="priority-bars"><i /><i /><i /></span>
    </span>
  );
}

/**
 * The glyph as a read-only property, with its label for assistive tech.
 *
 * `normal` renders NOTHING. It is the value a task gets when nobody chose
 * one, so a mark on every such row states the absence of a decision as
 * loudly as a decision. The rank is worth a mark only where it departs from
 * the default. Pass `always` where the record is being edited rather than
 * scanned, so the field still shows its current value.
 */
export function PriorityBadge({ priority, always = false }: { priority: TaskPriority; always?: boolean }) {
  const { t } = useTranslation();
  if (priority === "normal" && !always) return null;
  const label = t(`backlog.priorities.${priority}`);
  return (
    <Tooltip content={label}>
      <span className="priority-badge" data-priority={priority}>
        <PriorityGlyph priority={priority} />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}
