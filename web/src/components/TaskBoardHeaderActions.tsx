"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MobileTopbarActions, PHONE_QUERY } from "./MobileTopbarSlot";
import {
  ActionAdd,
  ActionImport,
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
  importLabel,
  onImport,
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
  importLabel?: string;
  /** Opens the GitHub issue import; omitted where nothing may be created. */
  onImport?: () => void;
  leading?: ReactNode;
  /** On a phone, the view toggle and create move into the top bar. For a
   *  toolbar that is not a PageHeader. */
  topbar?: boolean;
}) {
  /* A phone list is kept fresh by the shell's polling, and its top bar has
     room for three glyphs beside the bell, not four: refresh is a desktop
     affordance, and the GitHub import folds into the create plus as a menu. */
  const phone = useMediaQuery(PHONE_QUERY);
  const phoneImport = phone && onCreate && onImport && importLabel;
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
      {onImport && importLabel && !phone ? <Button
        type="button"
        variant="ghost"
        className="page-header-icon-action"
        tooltip={importLabel}
        onClick={onImport}
      >
        <ActionImport size={ICON.md} />
      </Button> : null}
      {phoneImport ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="page-header-icon-action page-header-icon-action--primary"
                aria-label={createLabel}
              >
                <ActionAdd size={ICON.md} />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onCreate}>
              <ActionAdd size={ICON.sm} aria-hidden="true" />
              {createLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onImport}>
              <ActionImport size={ICON.sm} aria-hidden="true" />
              {importLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : onCreate ? <Button
        type="button"
        variant="ghost"
        // A bare plus everywhere; the tooltip names it (and is its aria-label).
        className="page-header-icon-action page-header-icon-action--primary"
        tooltip={createLabel}
        onClick={onCreate}
      >
        <ActionAdd size={ICON.md} />
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
