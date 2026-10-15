"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { acceptWaitlistInvite, getWaitlistInvite, RelayApiError } from "../../api";
import type { CurrentUser, WaitlistInvite } from "../../types";
import { AuthCanvas } from "../AuthCanvas";
import { PublicLink } from "./PublicLink";
import { publicRequestError } from "./waitlistErrors";
import { inviteTokenFromHash } from "../../lib/waitlist";
import { isValidUserHandle, normalizeUserHandle } from "../../lib/userHandle";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "../../lib/passwordPolicy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface JoinScreenProps {
  onAuthenticated: (user: CurrentUser) => void;
}

/** The token, read from `#token=…` exactly once — the first render — so the
    hash can be dropped from the address bar straight after. */
function readInviteToken(): string | null {
  return typeof window === "undefined" ? null : inviteTokenFromHash(window.location.hash);
}

/**
 * `/join#token=…` — turn an invite into an account. The token rides in the
 * URL fragment so no server ever logs it, and leaves the address bar as soon
 * as it is read so it does not linger in history or a screenshot. A live
 * invite becomes a handle-and-password form; anything else (unknown, rotated,
 * expired, used) gets one explanation, because the server answers all of
 * them with the same 404 on purpose.
 */
export function JoinScreen({ onAuthenticated }: JoinScreenProps) {
  const { t } = useTranslation();
  const [token] = useState(readInviteToken);
  const [redeemedElsewhere, setRedeemedElsewhere] = useState(false);

  useEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const inviteQuery = useQuery({
    queryKey: ["waitlist", "invite", token],
    queryFn: ({ signal }) => getWaitlistInvite(token ?? "", signal),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
  });
  const lookupError = inviteQuery.error;
  const dead = token === null
    || redeemedElsewhere
    || (lookupError instanceof RelayApiError && lookupError.status === 404);

  return (
    <AuthCanvas mode="join">
      <h2 className="login-panel-title" id="join-title">
        {dead ? t("waitlist.join_dead_title") : t("waitlist.join_title")}
      </h2>
      {dead ? (
        <>
          <p className="login-note">{t("waitlist.join_dead_body")}</p>
          <p className="login-alt">
            <PublicLink href="/waitlist">{t("waitlist.request_access")}</PublicLink>
          </p>
        </>
      ) : lookupError ? (
        <p className="login-error" role="alert">{publicRequestError(lookupError, t)}</p>
      ) : inviteQuery.data ? (
        <JoinForm
          token={token ?? ""}
          invite={inviteQuery.data.invite}
          onAuthenticated={onAuthenticated}
          onDead={() => setRedeemedElsewhere(true)}
        />
      ) : (
        <p className="login-note" role="status">{t("waitlist.join_checking")}</p>
      )}
      <p className="login-alt">
        {t("waitlist.have_account")} <PublicLink href="/login">{t("login.sign_in")}</PublicLink>
      </p>
    </AuthCanvas>
  );
}

type JoinProblems = { handle?: string; password?: string };

function JoinForm({
  token,
  invite,
  onAuthenticated,
  onDead,
}: {
  token: string;
  invite: WaitlistInvite;
  onAuthenticated: (user: CurrentUser) => void;
  onDead: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [handle, setHandle] = useState(() => normalizeUserHandle(invite.suggestedHandle));
  const [password, setPassword] = useState("");
  const [problems, setProblems] = useState<JoinProblems>({});
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  function localProblems(): JoinProblems {
    const next: JoinProblems = {};
    if (!isValidUserHandle(handle)) next.handle = t("waitlist.handle_invalid");
    // The account's own names are the first guesses anyone makes. The
    // common-password blocklist lives server-side; its refusal arrives as a 400.
    const problem = passwordProblem(password, [handle, invite.name, invite.email]);
    if (problem) {
      next.password = t(`waitlist.password_problem_${problem}`, { min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH });
    }
    return next;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const next = localProblems();
    setProblems(next);
    if (next.handle || next.password) return;
    setIsBusy(true);
    try {
      const result = await acceptWaitlistInvite(token, { handle, password });
      onAuthenticated(result.user);
    } catch (err) {
      if (err instanceof RelayApiError && err.status === 404) onDead();
      else setError(publicRequestError(err, t));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="login-form" aria-labelledby="join-title" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <Field
        className="login-field"
        label={t("waitlist.email")}
        hint={t("waitlist.join_expires", { date: new Date(invite.expiresAt).toLocaleDateString(i18n.language, { dateStyle: "medium" }) })}
      >
        <Input className="login-input" name="email" type="email" value={invite.email} readOnly autoComplete="email" />
      </Field>
      <Field className="login-field" label={t("waitlist.handle")} error={problems.handle} errorId="join-handle-error">
        <Input
          className="login-input"
          name="handle"
          value={handle}
          onChange={(event) => setHandle(normalizeUserHandle(event.target.value))}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-invalid={problems.handle ? true : undefined}
          aria-describedby={problems.handle ? "join-handle-error" : undefined}
        />
      </Field>
      <Field className="login-field" label={t("login.password")} error={problems.password} errorId="join-password-error">
        <Input
          className="login-input"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={problems.password ? true : undefined}
          aria-describedby={problems.password ? "join-password-error" : undefined}
        />
      </Field>

      {error ? <p className="login-error" role="alert">{error}</p> : null}

      <Button
        variant="default"
        size="cta"
        type="submit"
        className="login-submit w-full"
        loading={isBusy}
        loadingLabel={t("waitlist.join_submitting")}
      >
        {t("waitlist.join_submit")}
      </Button>
    </form>
  );
}
