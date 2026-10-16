"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { issueUserPasswordReset, type AdminPasswordReset } from "../../api";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useOnOpen } from "@/hooks/useKeyChange";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CredCopyRow } from "./CredCopyRow";

const DELIVERY_HINT: Record<AdminPasswordReset["delivery"], string> = {
  sent: "admin.v2.password_reset_sent",
  skipped: "admin.v2.password_reset_not_sent",
  bounced: "admin.v2.password_reset_failed",
  failed: "admin.v2.password_reset_failed",
};

/** The edit drawer's Password section: mint a one-time reset link for this
    user. The link always comes back, so an install without email — or a user
    without an address — can still be handed one directly. Creating another
    retires the previous link. */
export function UserPasswordReset({ open, userId }: { open: boolean; userId: string }) {
  const { t, i18n } = useTranslation();
  const { copiedField, copy } = useCopyFeedback();
  const [issued, setIssued] = useState<AdminPasswordReset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // A link belongs to one viewing of one user; never carry it to the next.
  useOnOpen(open, () => {
    setIssued(null);
    setError(null);
    setIsBusy(false);
  }, userId);

  async function handleCreate() {
    setIsBusy(true);
    setError(null);
    try {
      setIssued(await issueUserPasswordReset(userId));
    } catch (err) {
      setError(t("admin.v2.password_reset_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  const expires = issued
    ? new Date(issued.expiresAt).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <section className="adm-provision-section" aria-labelledby="adm-edit-emp-password">
      <header className="adm-provision-section-head">
        <h3 id="adm-edit-emp-password" className="adm-provision-section-title">
          {t("admin.v2.section_password")}
        </h3>
      </header>
      <p className="adm-form-hint">{t("admin.v2.password_reset_hint")}</p>
      {issued ? (
        <CredCopyRow
          label={t("admin.v2.password_reset_link")}
          value={issued.url}
          copyLabel={t("admin.v2.password_reset_copy")}
          copied={copiedField === "reset-link"}
          onCopy={() => void copy("reset-link", issued.url)}
          hint={`${t(DELIVERY_HINT[issued.delivery])} ${t("admin.v2.password_reset_expires", { time: expires })}`}
        />
      ) : null}
      {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}
      <Button
        type="button"
        variant="outline"
        size="dense"
        className="self-start"
        loading={isBusy}
        onClick={() => void handleCreate()}
      >
        {t("admin.v2.password_reset_create")}
      </Button>
    </section>
  );
}
