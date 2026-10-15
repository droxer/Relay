"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ActionAdd, ICON } from "./icons";
import { StateMark, type StateShape, type StateTone } from "./StateMark";

/**
 * One group of a grouped list: a tinted band naming the group, then the rows
 * that belong to it.
 *
 * Every list view in the app groups, and each groups by the one dimension its
 * reader scans for — task status on the backlog, schedule health on routines,
 * fleet health on the admin user and computer lists. That is what pays
 * for the columns the rows no longer have to carry: a row inside a band
 * labelled "Blocked" has already said it is blocked, so the per-row status
 * word is gone and the width it held went to the record's own facts.
 *
 * The band carries the group's accent (`--row-accent`), which the caller sets
 * either from a `data-*` attribute the stylesheet maps (tasks, routines) or
 * from the `tone` prop (admin, whose statuses are open-ended strings), so the
 * band tint, the mark inside it, and the rows below are one signal rather
 * than three that can drift.
 */
export function ListGroup({
  label,
  count,
  shape,
  tone,
  addLabel,
  onAdd,
  children,
  ...section
}: {
  label: string;
  /** The group's WHOLE size, not the page on screen — that is what a band says. */
  count: number;
  /** Pass a shape when the caller knows it; `tone` derives one otherwise. */
  shape?: StateShape;
  /** Emits `.tone-*`, which is where an open-ended status gets its accent. */
  tone?: StateTone;
  addLabel?: string;
  onAdd?: () => void;
  children: ReactNode;
} & ComponentPropsWithoutRef<"section">) {
  return (
    <section className={cn("list-group", tone && `tone-${tone}`)} aria-label={label} {...section}>
      <header className="list-group-band">
        <StateMark shape={shape} tone={tone} />
        <span className="list-group-name">{label}</span>
        <span className="list-group-count tnum">{count}</span>
        {onAdd && addLabel ? (
          <Button
            variant="ghost"
            type="button"
            className="list-group-add"
            onClick={onAdd}
            tooltip={addLabel}
          >
            <ActionAdd size={ICON.sm} />
          </Button>
        ) : null}
      </header>
      {children}
    </section>
  );
}
