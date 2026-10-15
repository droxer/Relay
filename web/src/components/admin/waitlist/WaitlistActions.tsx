"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  declineWaitlistEntry,
  eraseWaitlistEntry,
  inviteWaitlistEntry,
  updateWaitlistNote,
} from "../../../api";
import type { WaitlistEntry, WaitlistInviteResult } from "../../../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMutationError } from "../../../hooks/useMutationError";
import { WAITLIST_LIMITS } from "../../../lib/waitlist";
import { ActionEdit, ActionRemove, AdminDelete, AdminInvite, ICON, NavMore } from "../../icons";
import { WAITLIST_QUERY_KEY } from "./useWaitlistQueue";

interface WaitlistActionsProps {
  entry: WaitlistEntry;
  /** Hands a freshly minted link to the one-time reveal. */
  onInvited: (results: WaitlistInviteResult[]) => void;
}

/** The overflow menu on one waitlist row. Which actions it offers follows the
    lifecycle: a joined or declined entry can only be noted or erased, and an
    invited one re-invites (rotating the token) instead of inviting. */
export function WaitlistActions({ entry, onInvited }: WaitlistActionsProps) {
  const { t } = useTranslation();
  const { confirm, prompt } = useDialogs();
  const { reportMutationError } = useMutationError();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const name = entry.name || entry.email;
  // Declined is closed (it is what stops a person requeueing) and joined is
  // terminal; only the two open states can be invited or turned down.
  const isOpen = entry.status === "waiting" || entry.status === "invited";

  async function run(action: () => Promise<void>, failure: string) {
    setPending(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: WAITLIST_QUERY_KEY });
    } catch (error) {
      reportMutationError(`Waitlist action failed: ${failure}`, error, t(`admin.waitlist.error_${failure}`));
    } finally {
      setPending(false);
    }
  }

  function handleInvite() {
    void run(async () => onInvited([await inviteWaitlistEntry(entry.id)]), "invite");
  }

  async function handleDecline() {
    const ok = await confirm({
      title: t("admin.waitlist.decline_confirm", { name }),
      message: t("admin.waitlist.decline_message"),
      confirmLabel: t("admin.waitlist.decline"),
    });
    if (ok) void run(async () => { await declineWaitlistEntry(entry.id); }, "decline");
  }

  async function handleNote() {
    const result = await prompt({
      title: t("admin.waitlist.note_title", { name }),
      message: t("admin.waitlist.note_message", { max: WAITLIST_LIMITS.adminNote }),
      defaultValue: entry.adminNote ?? "",
      confirmLabel: t("admin.waitlist.note_save"),
    });
    if (result === null) return;
    const note = result.trim().slice(0, WAITLIST_LIMITS.adminNote);
    if (note === (entry.adminNote ?? "")) return;
    void run(async () => { await updateWaitlistNote(entry.id, note || null); }, "note");
  }

  async function handleErase() {
    const ok = await confirm({
      title: t("admin.waitlist.erase_confirm", { email: entry.email }),
      message: t("admin.waitlist.erase_message"),
      confirmLabel: t("admin.waitlist.erase"),
      tone: "danger",
    });
    if (ok) void run(async () => { await eraseWaitlistEntry(entry.id); }, "erase");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="icon"
            size="icon-dense"
            disabled={pending}
            aria-label={t("admin.waitlist.more_actions", { name })}
            title={t("admin.waitlist.more_actions", { name })}
          >
            <NavMore size={ICON.md} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {isOpen ? (
          <DropdownMenuItem onClick={handleInvite}>
            <AdminInvite size={ICON.sm} aria-hidden="true" />
            {entry.status === "waiting" ? t("admin.waitlist.invite") : t("admin.waitlist.reinvite")}
          </DropdownMenuItem>
        ) : null}
        {isOpen ? (
          <DropdownMenuItem onClick={() => void handleDecline()}>
            <ActionRemove size={ICON.sm} aria-hidden="true" />
            {t("admin.waitlist.decline")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => void handleNote()}>
          <ActionEdit size={ICON.sm} aria-hidden="true" />
          {t("admin.waitlist.note_edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onClick={() => void handleErase()}>
          <AdminDelete size={ICON.sm} aria-hidden="true" />
          {t("admin.waitlist.erase")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
