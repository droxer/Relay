"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MobileTopbarActions, PHONE_QUERY } from "./MobileTopbarSlot";
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
  /** On a phone, the view toggle and create move into the top bar. For a
   *  toolbar that is not a PageHeader. */
  topbar?: boolean;
}) {
  /* A phone list is kept fresh by the shell's polling, and its top bar has
     room for three glyphs beside the bell, not four: refresh is a desktop
     affordance. */
  const phone = useMediaQuery(PHONE_QUERY);
  const buttons = (
    <>
      {onRefresh && !phone ? <Button
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
        // A visible label on desktop; the phone top bar keeps a named icon.
        className="page-header-icon-action page-header-icon-action--primary page-header-create-action"
        tooltip={createLabel}
        onClick={onCreate}
      >
        <ActionAdd size={ICON.md} />
        <span className="page-header-create-label">{createLabel}</span>
      </Button> : null}
    </>
  );
  return topbar ? (
    <MobileTopbarActions>{leading}{buttons}</MobileTopbarActions>
  ) : (
    <>
      {leading}
      {buttons}
    </>
  );
}
