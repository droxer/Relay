"use client";

import { useTranslation } from "react-i18next";
import type { WaitlistInviteResult } from "../../../types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { CredCopyRow } from "../CredCopyRow";

/**
 * The invite links just minted, shown once. Only the token's hash is stored,
 * so once this panel is dismissed (or the page reloads) the links are gone for
 * good — re-inviting mints a new one. That is why it stays until dismissed
 * rather than timing out, and why it says so. Delivery status belongs to the
 * refreshed queue below; the issuance response is only a snapshot.
 */
export function InviteReveal({ invites, onDismiss }: { invites: WaitlistInviteResult[]; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { copiedField, copy } = useCopyFeedback();
  return (
    <section className="adm-waitlist-reveal" aria-label={t("admin.waitlist.reveal_title", { count: invites.length })}>
      <Alert variant="boxed" render={<div />}>
        <span>{t("admin.waitlist.reveal_title", { count: invites.length })}</span>
        <span className="adm-cred-hint">{t("admin.waitlist.reveal_once")}</span>
        <Button type="button" variant="ghost" size="dense" onClick={onDismiss}>
          {t("admin.v2.dismiss")}
        </Button>
      </Alert>
      {invites.length === 0 ? (
        <p className="adm-cred-hint">{t("admin.waitlist.reveal_none")}</p>
      ) : invites.map(({ entry, inviteUrl }) => (
        <CredCopyRow
          key={entry.id}
          label={entry.name ? `${entry.name} · ${entry.email}` : entry.email}
          value={inviteUrl}
          copyLabel={t("admin.waitlist.copy_link")}
          copied={copiedField === entry.id}
          onCopy={() => void copy(entry.id, inviteUrl)}
        />
      ))}
    </section>
  );
}
