"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MobileTopbarActions } from "./MobileTopbarSlot";
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
  topbar = false,
}: {
  refreshLabel: string;
  createLabel: string;
  isRefreshing?: boolean;
  /** Omitted where the shell already keeps the list fresh. */
  onRefresh?: () => void;
  /** Omitted where nothing may be created (a read-only project). */
  onCreate?: () => void;
  leading?: ReactNode;
  /** On a phone, refresh and create move into the top bar; `leading` (a view
   *  toggle) stays where it is. For a toolbar that is not a PageHeader. */
  topbar?: boolean;
}) {
  const buttons = (
    <>
      {onRefresh ? <Button
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
      </Button> : null}
      {onCreate ? <Button
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
      </Button> : null}
    </>
  );
  return (
    <>
      {leading}
      {topbar ? <MobileTopbarActions>{buttons}</MobileTopbarActions> : buttons}
    </>
  );
}
