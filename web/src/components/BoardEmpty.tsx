"use client";

import { Button } from "@/components/ui/button";
import { RelayEmptyState } from "./RelayEmptyState";
import {
  ActionCompose,
  ICON,
} from "./icons";

// Shared empty-state for task boards (Backlog + Routine): the same
// `RelayEmptyState` primitive every other zero-data surface uses, turned
// left-aligned and inline with the page's normal content column by the
// `relay-empty--board` modifier — no centered mark tile.
export function BoardEmpty({
  title,
  body,
  createLabel,
  onCreate,
  clearLabel,
  onClear,
}: {
  title: string;
  body: string;
  createLabel?: string;
  onCreate?: () => void;
  clearLabel?: string;
  onClear?: () => void;
}) {
  return (
    <RelayEmptyState
      className="relay-empty--board"
      fill
      title={title}
      body={body}
      actions={onCreate && createLabel ? (
        // The board's one move earns the full 40px default tier — same as
        // every other empty-state primary; the clear action stays demoted.
        <Button onClick={onCreate}>
          <ActionCompose size={ICON.sm} />
          {createLabel}
        </Button>
      ) : onClear && clearLabel ? (
        <Button size="dense" variant="ghost" onClick={onClear}>
          {clearLabel}
        </Button>
      ) : undefined}
    />
  );
}
