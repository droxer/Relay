"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { login, RelayApiError } from "../api";
import type { CurrentUser } from "../types";
import { AuthCanvas } from "./AuthCanvas";
import { PublicLink } from "./waitlist/PublicLink";
import { usePasswordResetEnabled, useWaitlistEnabled } from "../hooks/useAuthStatus";
import { completedReset, forgetCompletedReset } from "../lib/passwordReset";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface LoginScreenProps {
  onAuthenticated: (user: CurrentUser) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const { t } = useTranslation();
  // Arriving from a finished reset: say so, and fill in whose password it was.
  const [resetFor] = useState(completedReset);
  const [username, setUsername] = useState(() => resetFor ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const waitlistEnabled = useWaitlistEnabled();
  const passwordResetEnabled = usePasswordResetEnabled();

  function errorMessage(err: unknown, unauthorizedMessage?: string): string {
    if (err instanceof RelayApiError && err.status === 401 && unauthorizedMessage) {
      return unauthorizedMessage;
    }
    return t("login.error_generic");
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const result = await login({ username: username.trim(), password });
      forgetCompletedReset();
      onAuthenticated(result.user);
    } catch (err) {
      setError(errorMessage(err, t("login.invalid")));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthCanvas mode="login">
      <h2 className="login-panel-title" id="login-form-title">
        {t("login.kicker_attach")}
      </h2>

      {resetFor && !error ? (
        <p className="login-note" role="status">{t("login.reset_done")}</p>
      ) : null}

      <form
        className="login-form"
        aria-labelledby="login-form-title"
        onSubmit={(event) => void handleLogin(event)}
      >
        <Field className="login-field" label={t("login.username")}>
          <Input
            className="login-input"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </Field>
        <Field className="login-field" label={t("login.password")}>
          <Input
            className="login-input"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </Field>
        {/* Only when the server can email a link; otherwise the page would
            just say to ask an admin, which this screen cannot know to say. */}
        {passwordResetEnabled === true ? (
          <p className="login-forgot">
            <PublicLink href="/forgot-password">{t("login.forgot_password")}</PublicLink>
          </p>
        ) : null}

        {error && (
          <p className="login-error" id="login-error" role="alert">
            {error}
          </p>
        )}

        <Button
          variant="default"
          size="cta"
          type="submit"
          className="login-submit w-full"
          loading={isLoading}
          loadingLabel={t("login.loading")}
        >
          {t("login.sign_in")}
        </Button>
      </form>

      {/* Only when the server takes requests: a link to a form that answers
          404 is a dead end dressed as an invitation. */}
      {waitlistEnabled === true ? (
        <p className="login-alt">
          {t("waitlist.no_account")} <PublicLink href="/waitlist">{t("waitlist.request_access")}</PublicLink>
        </p>
      ) : null}
    </AuthCanvas>
  );
}
