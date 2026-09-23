"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  ActionAdd,
  ICON,
  NavRefresh,
} from "./icons";

/** Refresh + primary create actions shared by Backlog and Routine headers. */
export function TaskBoardHeaderActions({
  refreshLabel,
  createLabel,
  isRefreshing,
  onRefresh,
  onCreate,
  leading,
}: {
  refreshLabel: string;
  createLabel: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  leading?: ReactNode;
}) {
  return (
    <>
      {leading}
      <Button
        type="button"
        variant="ghost"
        // Same ghost icon family as the create plus beside it — a bordered
        // 40px square next to a 36px ghost read as two unrelated controls.
        className="page-header-icon-action"
        tooltip={refreshLabel}
        disabled={isRefreshing}
        onClick={onRefresh}
      >
        <NavRefresh size={ICON.md} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        // The shared list-header create affordance, same as the
        // projects/threads rail — no text label, the header already names the
        // list. aria-label carries the action for the accessibility tree.
        className="page-header-icon-action page-header-icon-action--primary"
        tooltip={createLabel}
        onClick={onCreate}
      >
        <ActionAdd size={ICON.md} />
      </Button>
    </>
  );
}
