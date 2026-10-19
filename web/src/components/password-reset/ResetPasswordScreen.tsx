"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { completePasswordReset, getPasswordReset, RelayApiError } from "../../api";
import { AuthCanvas } from "../AuthCanvas";
import { PublicLink } from "../waitlist/PublicLink";
import { publicRequestError } from "../waitlist/waitlistErrors";
import { navigateToAppPath } from "../../lib/appRoute";
import { rememberCompletedReset, resetTokenFromHash } from "../../lib/passwordReset";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "../../lib/passwordPolicy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** The token, read from `#token=…` exactly once — the first render — so the
    hash can be dropped from the address bar straight after. */
function readResetToken(): string | null {
  return typeof window === "undefined" ? null : resetTokenFromHash(window.location.hash);
}

/**
 * `/reset-password#token=…` — choose a new password from an emailed (or
 * admin-issued) link. The token rides in the fragment so no server logs it,
 * and leaves the address bar as soon as it is read. Every dead link — unknown,
 * superseded, expired, used — gets one explanation, because the server answers
 * them all with the same 404. Success signs nobody in: it hands over to the
 * sign-in screen with the username filled in.
 */
export function ResetPasswordScreen() {
  const { t } = useTranslation();
  const [token] = useState(readResetToken);
  const [spentElsewhere, setSpentElsewhere] = useState(false);

  useEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const resetQuery = useQuery({
    queryKey: ["password-reset", token],
    queryFn: ({ signal }) => getPasswordReset(token ?? "", signal),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
  });
  const lookupError = resetQuery.error;
  const dead = token === null
    || spentElsewhere
    || (lookupError instanceof RelayApiError && lookupError.status === 404);

  return (
    <AuthCanvas mode="reset-password">
      <h2 className="login-panel-title" id="reset-title">
        {dead ? t("password_reset.dead_title") : t("password_reset.choose_title")}
      </h2>
      {dead ? (
        <>
          <p className="login-note">{t("password_reset.dead_body")}</p>
          <p className="login-alt">
            <PublicLink href="/forgot-password">{t("password_reset.request_new")}</PublicLink>
          </p>
        </>
      ) : lookupError ? (
        <>
          <p className="login-error" role="alert">{resetError(lookupError, t)}</p>
          <Button
            type="button"
            className="login-submit w-full"
            size="lg"
            loading={resetQuery.isFetching}
            onClick={() => void resetQuery.refetch()}
          >
            {t("password_reset.retry_lookup")}
          </Button>
        </>
      ) : resetQuery.data ? (
        <ResetPasswordForm
          token={token ?? ""}
          username={resetQuery.data.reset.username}
          onDead={() => setSpentElsewhere(true)}
        />
      ) : (
        <p className="login-note" role="status">{t("password_reset.checking")}</p>
      )}
      <p className="login-alt">
        <PublicLink href="/login">{t("password_reset.back_to_sign_in")}</PublicLink>
      </p>
    </AuthCanvas>
  );
}

type ResetProblems = { password?: string; confirm?: string };

function ResetPasswordForm({
  token,
  username,
  onDead,
}: {
  token: string;
  username: string;
  onDead: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problems, setProblems] = useState<ResetProblems>({});
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  function localProblems(): ResetProblems {
    // The username is the first guess anyone makes. The common-password
    // blocklist lives server-side; its refusal arrives as a 400.
    const problem = passwordProblem(password, [username]);
    if (problem) {
      return {
        password: t(`waitlist.password_problem_${problem}`, { min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }),
      };
    }
    return confirm === password ? {} : { confirm: t("password_reset.mismatch") };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const next = localProblems();
    setProblems(next);
    if (next.password || next.confirm) return;
    setIsBusy(true);
    try {
      const result = await completePasswordReset(token, password);
      rememberCompletedReset(result.username);
      void navigateToAppPath("/login", { replace: true });
    } catch (err) {
      if (err instanceof RelayApiError && err.status === 404) onDead();
      else setError(resetError(err, t));
      setIsBusy(false);
    }
  }

  return (
    <form className="login-form" aria-labelledby="reset-title" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <p className="login-note">{t("password_reset.choose_for", { username })}</p>
      {/* Lets a password manager file the new password under the right account. */}
      <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
      <Field className="login-field" label={t("password_reset.new_password")} error={problems.password} errorId="reset-password-error">
        <Input
          className="login-input"
          name="new-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={problems.password ? true : undefined}
          aria-describedby={problems.password ? "reset-password-error" : undefined}
        />
      </Field>
      <Field className="login-field" label={t("password_reset.confirm_password")} error={problems.confirm} errorId="reset-confirm-error">
        <Input
          className="login-input"
          name="confirm-password"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={problems.confirm ? true : undefined}
          aria-describedby={problems.confirm ? "reset-confirm-error" : undefined}
        />
      </Field>

      {error ? <p className="login-error" role="alert">{error}</p> : null}

      <Button
        variant="default"
        size="lg"
        type="submit"
        className="login-submit w-full"
        loading={isBusy}
        loadingLabel={t("password_reset.complete_submitting")}
      >
        {t("password_reset.complete_submit")}
      </Button>
    </form>
  );
}

function resetError(err: unknown, t: TFunction): string {
  if (err instanceof RelayApiError && err.status === 429) return t("password_reset.error_rate_limited");
  return publicRequestError(err, t);
}
