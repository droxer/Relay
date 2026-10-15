"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { joinWaitlist } from "../../api";
import { AuthCanvas } from "../AuthCanvas";
import { PublicLink } from "./PublicLink";
import { publicRequestError } from "./waitlistErrors";
import { useWaitlistEnabled } from "../../hooks/useAuthStatus";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  EMPTY_WAITLIST_FIELDS,
  WAITLIST_LIMITS,
  waitlistFieldProblems,
  waitlistJoinInput,
  waitlistLocale,
  waitlistSource,
  type WaitlistField,
  type WaitlistFields,
} from "../../lib/waitlist";

/** Read once, when the page opens: a later client navigation would have
    replaced the referrer with our own page and dropped `utm_source`. */
function initialSource(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return waitlistSource(window.location, document.referrer);
}

/**
 * `/waitlist` — request access. Stands on the sign-in canvas so the brand
 * moment carries over, and swaps its form for one calm confirmation once the
 * server accepts. The server answers the same `202` whether the address is
 * new, already waiting, or long since declined, so the confirmation is one
 * sentence for all of them: nothing on this page may tell a visitor whether
 * an email is known.
 */
export function WaitlistScreen() {
  const { t } = useTranslation();
  const enabled = useWaitlistEnabled();
  const [submitted, setSubmitted] = useState(false);

  return (
    <AuthCanvas mode="waitlist">
      <div className="login-panel-head">
        <h2 className="login-panel-title" id="waitlist-title">
          {submitted ? t("waitlist.confirm_title") : t("waitlist.title")}
        </h2>
        {submitted ? (
          <p className="login-note" role="status">{t("waitlist.confirm_body")}</p>
        ) : enabled === false ? (
          <p className="login-note">{t("waitlist.error_unavailable")}</p>
        ) : (
          <p className="login-note">{t("waitlist.lede")}</p>
        )}
      </div>
      {submitted || enabled === false ? null : <WaitlistForm onSubmitted={() => setSubmitted(true)} />}
      <p className="login-alt">
        {t("waitlist.have_account")} <PublicLink href="/login">{t("login.sign_in")}</PublicLink>
      </p>
    </AuthCanvas>
  );
}

const OPTIONAL_FIELDS = [
  { field: "name", label: "waitlist.name", autoComplete: "name" },
  { field: "company", label: "waitlist.company", autoComplete: "organization" },
  { field: "role", label: "waitlist.role", autoComplete: "organization-title" },
] as const;

function WaitlistForm({ onSubmitted }: { onSubmitted: () => void }) {
  const { t, i18n } = useTranslation();
  const [fields, setFields] = useState<WaitlistFields>(EMPTY_WAITLIST_FIELDS);
  const [honeypot, setHoneypot] = useState("");
  const [source] = useState(initialSource);
  const [showProblems, setShowProblems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const problems = showProblems ? waitlistFieldProblems(fields) : {};

  function update(field: WaitlistField, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
  }

  function problemText(field: WaitlistField): string | undefined {
    const problem = problems[field];
    if (!problem) return undefined;
    return t(`waitlist.problem_${problem}`, { max: WAITLIST_LIMITS[field] });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (Object.keys(waitlistFieldProblems(fields)).length > 0) {
      setShowProblems(true);
      return;
    }
    setIsBusy(true);
    try {
      await joinWaitlist(waitlistJoinInput(fields, { honeypot, source, locale: waitlistLocale(i18n.language) }));
      onSubmitted();
    } catch (err) {
      setError(publicRequestError(err, t));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="login-form" aria-labelledby="waitlist-title" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <Field className="login-field" label={t("waitlist.email")} error={problemText("email")} errorId="waitlist-email-error">
        <Input
          className="login-input"
          name="email"
          type="email"
          value={fields.email}
          onChange={(event) => update("email", event.target.value)}
          autoComplete="email"
          spellCheck={false}
          required
          aria-invalid={problems.email ? true : undefined}
          aria-describedby={problems.email ? "waitlist-email-error" : undefined}
        />
      </Field>
      {OPTIONAL_FIELDS.map(({ field, label, autoComplete }) => (
        <Field
          key={field}
          className="login-field"
          label={<>{t(label)} <span className="login-optional">{t("waitlist.optional")}</span></>}
          error={problemText(field)}
          errorId={`waitlist-${field}-error`}
        >
          <Input
            className="login-input"
            name={field}
            value={fields[field]}
            onChange={(event) => update(field, event.target.value)}
            autoComplete={autoComplete}
            aria-invalid={problems[field] ? true : undefined}
            aria-describedby={problems[field] ? `waitlist-${field}-error` : undefined}
          />
        </Field>
      ))}
      <Field
        className="login-field"
        label={<>{t("waitlist.use_case")} <span className="login-optional">{t("waitlist.optional")}</span></>}
        error={problemText("useCase")}
        errorId="waitlist-useCase-error"
      >
        <Textarea
          className="login-input login-textarea"
          name="useCase"
          rows={3}
          value={fields.useCase}
          onChange={(event) => update("useCase", event.target.value)}
          aria-invalid={problems.useCase ? true : undefined}
          aria-describedby={problems.useCase ? "waitlist-useCase-error" : undefined}
        />
      </Field>
      {/* The honeypot. Hidden from people and assistive tech alike, out of
          the tab order, and never autofilled — so anything in it was typed
          by something that reads the markup rather than the page. */}
      <input
        className="login-honeypot"
        type="text"
        name="website"
        value={honeypot}
        onChange={(event) => setHoneypot(event.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
      />

      {error ? <p className="login-error" role="alert">{error}</p> : null}

      <Button
        variant="default"
        size="cta"
        type="submit"
        className="login-submit w-full"
        loading={isBusy}
        loadingLabel={t("waitlist.submitting")}
      >
        {t("waitlist.submit")}
      </Button>
    </form>
  );
}
