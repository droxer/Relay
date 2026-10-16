"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { requestPasswordReset } from "../../api";
import { AuthCanvas } from "../AuthCanvas";
import { PublicLink } from "../waitlist/PublicLink";
import { publicRequestError } from "../waitlist/waitlistErrors";
import { usePasswordResetEnabled } from "../../hooks/useAuthStatus";
import { resetIdentifierProblem } from "../../lib/passwordReset";
import { waitlistLocale } from "../../lib/waitlist";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * `/forgot-password` — ask for a reset link. The server answers the same
 * `202` whether or not an account matched, so the confirmation is one
 * sentence for every case: nothing here may tell a visitor whether a
 * username or email is known.
 */
export function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const enabled = usePasswordResetEnabled();
  const [sent, setSent] = useState(false);

  return (
    <AuthCanvas mode="forgot-password">
      <div className="login-panel-head">
        <h2 className="login-panel-title" id="forgot-title">
          {sent ? t("password_reset.sent_title") : t("password_reset.request_title")}
        </h2>
        {sent ? (
          <p className="login-note" role="status">{t("password_reset.sent_body")}</p>
        ) : enabled === false ? (
          <p className="login-note">{t("password_reset.unavailable")}</p>
        ) : (
          <p className="login-note">{t("password_reset.request_lede")}</p>
        )}
      </div>
      {sent || enabled === false ? null : <ForgotPasswordForm onSent={() => setSent(true)} />}
      {sent ? <p className="login-note">{t("password_reset.ask_admin")}</p> : null}
      <p className="login-alt">
        <PublicLink href="/login">{t("password_reset.back_to_sign_in")}</PublicLink>
      </p>
    </AuthCanvas>
  );
}

function ForgotPasswordForm({ onSent }: { onSent: () => void }) {
  const { t, i18n } = useTranslation();
  const [identifier, setIdentifier] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const shape = resetIdentifierProblem(identifier);
    setProblem(shape ? t(`password_reset.problem_${shape}`) : null);
    if (shape) return;
    setIsBusy(true);
    try {
      await requestPasswordReset({ identifier: identifier.trim(), locale: waitlistLocale(i18n.language) });
      onSent();
    } catch (err) {
      setError(publicRequestError(err, t));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="login-form" aria-labelledby="forgot-title" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <Field className="login-field" label={t("password_reset.identifier")} error={problem ?? undefined} errorId="forgot-identifier-error">
        <Input
          className="login-input"
          name="identifier"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "forgot-identifier-error" : undefined}
        />
      </Field>

      {error ? <p className="login-error" role="alert">{error}</p> : null}

      <Button
        variant="default"
        size="cta"
        type="submit"
        className="login-submit w-full"
        loading={isBusy}
        loadingLabel={t("password_reset.submitting")}
      >
        {t("password_reset.submit")}
      </Button>
    </form>
  );
}
