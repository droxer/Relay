"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { inviteWaitlistBatch } from "../../../api";
import type { WaitlistInviteResult } from "../../../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useMutationError } from "../../../hooks/useMutationError";
import { MAX_INVITE_BATCH, MIN_INVITE_BATCH, parseInviteBatch } from "../../../lib/waitlist";
import { AdminInvite, ICON } from "../../icons";
import { WAITLIST_QUERY_KEY } from "./useWaitlistQueue";

/** The suggested batch — small enough that an admin reads every link. */
const DEFAULT_BATCH = 10;

/** "Invite next N": the waiting queue's oldest N, in one request. An outline
    beside the section's primary, Invite by email — one cobalt fill per fold. */
export function InviteNextButton({ onInvited }: { onInvited: (results: WaitlistInviteResult[]) => void }) {
  const { t } = useTranslation();
  const { prompt, announce } = useDialogs();
  const { reportMutationError } = useMutationError();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    const raw = await prompt({
      title: t("admin.waitlist.invite_next_title"),
      message: t("admin.waitlist.invite_next_message", { min: MIN_INVITE_BATCH, max: MAX_INVITE_BATCH }),
      defaultValue: String(DEFAULT_BATCH),
      confirmLabel: t("admin.waitlist.invite_next_confirm"),
    });
    if (raw === null) return;
    const count = parseInviteBatch(raw);
    if (count === null) {
      announce({ message: t("admin.waitlist.invite_next_invalid", { min: MIN_INVITE_BATCH, max: MAX_INVITE_BATCH }), tone: "warn" });
      return;
    }
    setPending(true);
    try {
      const result = await inviteWaitlistBatch(count);
      onInvited(result.invites);
      await queryClient.invalidateQueries({ queryKey: WAITLIST_QUERY_KEY });
    } catch (error) {
      reportMutationError("Waitlist batch invite failed", error, t("admin.waitlist.error_invite"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="adm-create-action"
      onClick={() => void handleClick()}
      disabled={pending}
      tooltip={t("admin.waitlist.invite_next")}
    >
      <AdminInvite size={ICON.md} aria-hidden="true" />
      {t("admin.waitlist.invite_next")}
    </Button>
  );
}
