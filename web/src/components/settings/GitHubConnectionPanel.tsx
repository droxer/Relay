"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { disconnectGitHub, getGitHubConnection, startGitHubConnection } from "../../api";
import { Button } from "../ui/button";
import { AdminConnect } from "../icons";

/** The same account connection controls in Settings and the import drawer. */
export function GitHubConnectionPanel({ accountId, fromImport = false }: { accountId: string; fromImport?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const connectionKey = ["github-connection", accountId] as const;
  const connection = useQuery({ queryKey: connectionKey, queryFn: getGitHubConnection, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const result = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("githubConnection");

  async function connect() {
    setBusy(true);
    setError(false);
    try {
      const returnTo = new URL(window.location.href);
      returnTo.searchParams.delete("githubConnection");
      if (fromImport) returnTo.searchParams.set("githubImport", "1");
      const response = await startGitHubConnection(returnTo.pathname + returnTo.search);
      const url = new URL(response.authorizeUrl);
      if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") throw new Error("Invalid authorization URL");
      window.location.assign(url.toString());
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(false);
    try {
      await disconnectGitHub();
      await queryClient.invalidateQueries({ queryKey: connectionKey });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const status = connection.data;
  return (
    <section className="github-connection" aria-label={t("github_connection.title")}>
      <h3 className="github-connection-title"><AdminConnect aria-hidden="true" />{t("github_connection.title")}</h3>
      {connection.isPending ? <p aria-live="polite">{t("github_connection.loading")}</p> : connection.isError ? (
        <><p role="alert">{t("github_connection.load_error")}</p><Button type="button" variant="outline" onClick={() => void connection.refetch()}>{t("github_connection.retry")}</Button></>
      ) : !status?.configured ? <p>{t("github_connection.not_configured")}</p> : (
        <>
          <p>{status.connected ? <><span translate="no">@{status.login}</span> — {t("github_connection.connected")}</> : t("github_connection.description")}</p>
          <p className="github-connection-hint">{t("github_connection.permissions")}</p>
          {result === "cancelled" ? <p role="status">{t("github_connection.cancelled")}</p> : null}
          {result === "failed" ? <p role="alert">{t("github_connection.error")}</p> : null}
          {result === "permissions" ? <p role="alert">{t("github_connection.permissions_error")}</p> : null}
          {result === "connected" && status.connected ? <p role="status">{t("github_connection.success")}</p> : null}
          {status.reconnectRequired ? <p role="alert">{t("github_connection.reconnect_hint")}</p> : null}
          <div className="github-connection-actions">
            <Button type="button" variant={status.connected ? "outline" : "default"} disabled={busy} loading={busy} onClick={() => void connect()}>
              {t(status.connected || status.reconnectRequired ? "github_connection.reconnect" : "github_connection.connect")}
            </Button>
            {status.connected ? <>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void disconnect()}>{t("github_connection.disconnect")}</Button>
              {status.manageUrl === "https://github.com/settings/installations"
                ? <a href={status.manageUrl} target="_blank" rel="noopener noreferrer">{t("github_connection.manage")}</a> : null}
            </> : null}
          </div>
        </>
      )}
      {error ? <p role="alert">{t("github_connection.error")}</p> : null}
    </section>
  );
}
