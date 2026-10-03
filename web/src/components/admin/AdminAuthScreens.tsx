"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { bootstrapUser, login } from "../../api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RelayMark } from "../RelayMark";
import { ICON } from "../icons";
import { Alert } from "@/components/ui/alert";

interface AdminLoginScreenProps {
  onLogin: () => void;
  needsBootstrap: boolean;
  onSwitchToBootstrap: () => void;
}

interface FirstAdminSetupScreenProps {
  onBootstrapped: () => void;
  onSwitchToLogin: () => void;
}

function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="adm-auth-shell">
      <div className="adm-auth-card">
        <div className="adm-auth-brand">
          <RelayMark size={ICON.xl} />
          <span className="sr-only">Relay · {t("nav.admin")}</span>
        </div>
        {children}
      </div>
    </section>
  );
}

export function AdminLoginScreen({ onLogin, needsBootstrap, onSwitchToBootstrap }: AdminLoginScreenProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await login({ username: username.trim(), password });
      onLogin();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(message ? t("admin.v2.action_failed", { message }) : t("admin.error_generic"));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthShell>
      <header className="adm-auth-head">
        <h1 className="adm-auth-title">{t("admin.login")}</h1>
        <p className="adm-auth-sub">
          {needsBootstrap ? t("admin.no_admins") : t("admin.login_sub")}
        </p>
      </header>
      <form className="adm-form" onSubmit={(event) => void handleSubmit(event)}>
        <Field label={t("admin.username")}>
          <Input
            name="username"
            className="code"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
            required
          />
        </Field>
        <Field label={t("admin.password")}>
          <Input
            name="password"
            className="code"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}
        <Button
          type="submit"
          className="w-full"
          loading={isLoading}
          loadingLabel={t("admin.signing_in")}
        >
          {t("admin.sign_in")}
        </Button>
        {needsBootstrap ? (
          <Button type="button" variant="ghost" className="w-full" onClick={onSwitchToBootstrap}>
            {t("login.go_bootstrap")}
          </Button>
        ) : null}
      </form>
    </AuthShell>
  );
}

export function FirstAdminSetupScreen({ onBootstrapped, onSwitchToLogin }: FirstAdminSetupScreenProps) {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await bootstrapUser({ token: token.trim(), username: username.trim(), password });
      onBootstrapped();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(message ? t("admin.v2.action_failed", { message }) : t("admin.error_generic"));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthShell>
      <header className="adm-auth-head">
        <h1 className="adm-auth-title">{t("admin.bootstrap")}</h1>
        <p className="adm-auth-sub">{t("admin.bootstrap_sub")}</p>
      </header>
      <form className="adm-form" onSubmit={(event) => void handleSubmit(event)}>
        <Field label={t("admin.bootstrap_token")}>
          <Input
            name="bootstrap-token"
            className="code"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </Field>
        <Field label={t("admin.username")}>
          <Input
            name="username"
            className="code"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
            required
          />
        </Field>
        <Field label={t("admin.password")}>
          <Input
            name="password"
            className="code"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}
        <Button
          type="submit"
          className="w-full"
          loading={isLoading}
          loadingLabel={t("admin.creating")}
        >
          {t("admin.create_admin")}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={onSwitchToLogin}>
          {t("login.go_login")}
        </Button>
      </form>
    </AuthShell>
  );
}
