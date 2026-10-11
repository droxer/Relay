"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ActionCalendar, ICON } from "../icons";

/**
 * The due-date cell of a list row — a date, or the offer to set one.
 *
 * An unset date used to print "No due date" in the same ink as a real one,
 * which spends a column on a fact nobody acts on. Empty is now an
 * affordance: it opens the record where the date is set, so the column reads
 * as work to do rather than as a filled-in nothing. A set date carries no
 * glyph: the column header already says what the value is, and a calendar on
 * every row was a column of identical icons.
 */
export function TaskDueCell({
  date,
  tone,
  format,
  emptyLabel,
  onEdit,
}: {
  date?: string;
  /** From `dueTone` / `routineDueTone` — `neutral` carries no colour. */
  tone: string;
  format: (value: string) => string;
  emptyLabel: string;
  onEdit: () => void;
}) {
  if (!date) {
    return (
      <Button variant="ghost" type="button" className="backlog-due-empty" onClick={onEdit}>
        <ActionCalendar size={ICON.sm} />
        <span>{emptyLabel}</span>
      </Button>
    );
  }
  return (
    <span className={cn("backlog-due-value", tone !== "neutral" && tone)}>
      {format(date)}
    </span>
  );
}
