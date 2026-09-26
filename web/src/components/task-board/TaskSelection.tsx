"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { AdminDelete, ICON } from "../icons";
import type { SelectionCheckState } from "../../lib/taskSelection";

/**
 * The two pieces of the batch-action surface, shared by the backlog board and
 * the routines board: the per-record checkbox and the bar that acts on what is
 * checked. They live together because they are one interaction — a checkbox
 * with no bar is a dead control, and a bar with no count is a lie.
 */

export function TaskSelectCheckbox({
  checked,
  label,
  className,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  className?: string;
  onCheckedChange: () => void;
}) {
  return (
    <Checkbox
      className={className}
      checked={checked}
      aria-label={label}
      // The row/card behind this control opens the edit drawer on click; the
      // checkbox must pick the record, not also open it.
      onClick={(event) => event.stopPropagation()}
      onCheckedChange={() => onCheckedChange()}
    />
  );
}

export function TaskSelectAllCheckbox({
  state,
  label,
  onToggle,
}: {
  state: SelectionCheckState;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Checkbox
      className="backlog-select-box"
      checked={state === "all"}
      indeterminate={state === "some"}
      aria-label={label}
      onCheckedChange={() => onToggle()}
    />
  );
}

/**
 * Anchored to the bottom of the board rather than replacing the page header:
 * the header keeps its create/refresh actions available, and the bar can name
 * the count without the record list jumping when a selection starts.
 */
export function TaskSelectionBar({
  count,
  deleting,
  onDelete,
  onClear,
  deleteLabel,
  actions,
}: {
  count: number;
  deleting: boolean;
  onDelete: () => void;
  onClear: () => void;
  deleteLabel: string;
  /** Surface-specific batch actions (Issues' move-to-project), set before Clear. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  if (count === 0) return null;

  return (
    <div className="task-selection-bar" role="region" aria-label={t("backlog.selection")}>
      <p className="task-selection-count" aria-live="polite">{t("backlog.selected", { count })}</p>
      <div className="task-selection-actions">
        {actions}
        <Button variant="ghost" type="button" onClick={onClear} disabled={deleting}>
          {t("backlog.clear_selection")}
        </Button>
        <Button variant="destructive" type="button" onClick={onDelete} disabled={deleting}>
          <AdminDelete size={ICON.sm} />
          {deleting ? t("backlog.deleting") : deleteLabel}
        </Button>
      </div>
    </div>
  );
}
