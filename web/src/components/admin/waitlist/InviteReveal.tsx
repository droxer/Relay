"use client";

import { useTranslation } from "react-i18next";
import type { WaitlistInviteResult } from "../../../types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { TonePill } from "../../StatusPill";
import { deliveryFailed, deliveryLabelKey, deliveryTone } from "../../../lib/waitlist";
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
      ) : invites.map(({ entry, inviteUrl, delivery }) => (
        <div key={entry.id} className="adm-waitlist-reveal-item">
          <CredCopyRow
            label={entry.name ? `${entry.name} · ${entry.email}` : entry.email}
            value={inviteUrl}
            copyLabel={t("admin.waitlist.copy_link")}
            copied={copiedField === entry.id}
            onCopy={() => void copy(entry.id, inviteUrl)}
          />
          {/* What happened to the email, said where the link is: a failed
              send is exactly when the admin needs to copy it by hand. Only a
              final outcome — a batch's "queued" is a snapshot that goes stale,
              so its result shows in the refreshing queue instead. No delivery
              at all means invite email is off and the link is the invite. */}
          {!delivery || delivery.status === "queued" ? null : <p className="adm-waitlist-delivery">
            <TonePill tone={deliveryTone(delivery.status)} label={t(deliveryLabelKey(delivery.status))} />
            {delivery.error && (deliveryFailed(delivery.status) || delivery.status === "skipped") ? (
              <span className={deliveryFailed(delivery.status) ? "adm-waitlist-delivery-error" : undefined}>
                {delivery.error}
              </span>
            ) : null}
          </p>}
        </div>
      ))}
    </section>
  );
}
