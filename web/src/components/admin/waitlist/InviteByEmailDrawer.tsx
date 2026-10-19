"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { inviteByEmail } from "../../../api";
import type { WaitlistInviteResult } from "../../../types";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOnOpen } from "@/hooks/useKeyChange";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { INVITE_LOCALES, inviteEmailProblem, waitlistLocale, WAITLIST_LIMITS, type InviteLocale } from "../../../lib/waitlist";
import { WAITLIST_QUERY_KEY } from "./useWaitlistQueue";

interface InviteByEmailDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Whether the server can email the link. Off, the invite is still made
      and its link shown once, for the admin to hand over. */
  canEmail: boolean;
  onInvited: (results: WaitlistInviteResult[]) => void;
}

/**
 * Admin → Waitlist → Invite by email (or by link, while invite email is off):
 * invite someone who never asked. The
 * server reuses the person's entry when they already did, so nobody is
 * invited twice, and refuses an address an account already holds.
 */
export function InviteByEmailDrawer({ open, onClose, canEmail, onInvited }: InviteByEmailDrawerProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const localeLabelId = useId();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [locale, setLocale] = useState<InviteLocale>(() => waitlistLocale(i18n.language));
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  /* `items` maps a value to its label: without it the trigger shows the raw
     locale code (`zh-CN`) until the popup has mounted once. */
  const localeItems = INVITE_LOCALES.map((option) => ({
    value: option,
    label: t(`admin.waitlist.invite_email_language_${option === "zh-CN" ? "zh" : "en"}`),
  }));
  const confirmDiscardChanges = useUnsavedChangesGuard(open && Boolean(email.trim() || name.trim()) && !isBusy);

  useOnOpen(open, () => {
    setEmail("");
    setName("");
    setLocale(waitlistLocale(i18n.language));
    setEmailError(null);
    setError(null);
    setIsBusy(false);
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = inviteEmailProblem(email);
    if (problem) {
      setEmailError(t(`admin.waitlist.invite_email_${problem}`));
      emailRef.current?.focus();
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      /* The language only picks the email's; a link-only invite has none. */
      const result = await inviteByEmail({
        email: email.trim(),
        name: name.trim() || undefined,
        locale: canEmail ? locale : undefined,
      });
      onInvited([result]);
      await queryClient.invalidateQueries({ queryKey: WAITLIST_QUERY_KEY });
      onClose();
    } catch (err) {
      setError(t(canEmail ? "admin.waitlist.invite_email_error" : "admin.waitlist.invite_link_error", {
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setIsBusy(false);
    }
  }

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("admin.waitlist.invite_email_kicker")}
      title={t("admin.waitlist.invite_email_title")}
      subtitle={canEmail ? t("admin.waitlist.invite_email_sub") : t("admin.waitlist.invite_email_sub_link")}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      width="form"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <section className="adm-provision-section">
          <Field
            label={t("admin.email")}
            required
            error={emailError ?? undefined}
            errorId="invite-email-error"
          >
            <Input
              ref={emailRef}
              data-modal-initial-focus
              name="invite-email"
              className="code"
              type="email"
              maxLength={WAITLIST_LIMITS.email}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
              /* Someone else's address: the browser must not offer the
                 signed-in admin's own saved emails. */
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_email")}
              aria-invalid={Boolean(emailError) || undefined}
              aria-describedby={emailError ? "invite-email-error" : undefined}
            />
          </Field>

          <Field
            label={t("admin.display_name")}
            optional={t("admin.v2.optional")}
            hint={canEmail ? t("admin.waitlist.invite_email_name_hint") : undefined}
          >
            <Input
              name="invite-name"
              maxLength={WAITLIST_LIMITS.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              placeholder={t("admin.v2.placeholder_display_name")}
            />
          </Field>

          {canEmail ? <Field label={t("admin.waitlist.invite_email_language")} labelId={localeLabelId} wrapper="div">
            <Select
              value={locale}
              items={localeItems}
              onValueChange={(value) => { if (value) setLocale(value as InviteLocale); }}
            >
              <SelectTrigger className="w-full" aria-labelledby={localeLabelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {localeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field> : null}
        </section>

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={isBusy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy}>
            {canEmail ? t("admin.waitlist.invite_email_send") : t("admin.waitlist.invite_email_create_link")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
