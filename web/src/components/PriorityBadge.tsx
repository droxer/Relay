import { useTranslation } from "react-i18next";
import type { TaskPriority } from "../types";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Priority is a rank, not a status — so it gets its own visual language:
 * three ascending signal bars filled to the level (low = 1, normal = 2,
 * high = 3) instead of the leading status dot the generic Badge uses. The
 * accent escalates low → normal → high (muted → ink → warn) — warn, not the
 * bad tier: priority is a rank, never failure severity. The textual label
 * doubles as the tooltip.
 *
 * `normal` renders NOTHING. It is the value a task gets when nobody chose
 * one, so a badge on every such row states the absence of a decision as
 * loudly as a decision — and it did, on every card and every row of both
 * boards, which is most of why a full backlog read as noise. The rank is
 * worth a mark only where it departs from the default, and the two that do
 * keep the badge unchanged. Pass `always` where the record is being edited
 * rather than scanned, so the field still shows its current value.
 */
export function PriorityBadge({ priority, always = false }: { priority: TaskPriority; always?: boolean }) {
  const { t } = useTranslation();
  if (priority === "normal" && !always) return null;
  const label = t(`backlog.priorities.${priority}`);
  return (
    <Tooltip content={label}>
      <span className="priority-badge" data-priority={priority}>
        <span className="priority-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="priority-badge-label">{label}</span>
      </span>
    </Tooltip>
  );
}
