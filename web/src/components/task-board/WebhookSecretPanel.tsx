"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RelayApiError, rotateWebhookSecret, webhookSecretStatus } from "../../api";
import { backendPublicOrigin } from "../../lib/apiOrigin";
import { Button } from "@/components/ui/button";

export function WebhookSecretPanel({ taskId }: { taskId?: string }) {
  const { t } = useTranslation();
  if (!taskId) return <p className="adm-form-hint">{t("automation.webhook_save_first")}</p>;
  return <SavedWebhookPanel key={taskId} taskId={taskId} />;
}

function SavedWebhookPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const status = useQuery({
    queryKey: ["automation-webhook", taskId],
    queryFn: ({ signal }) => webhookSecretStatus(taskId, signal),
    retry: false,
  });
  // Use local state rather than a mutation: its cache must never retain plaintext.
  async function rotate() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    setSecret(null);
    try {
      const result = await rotateWebhookSecret(taskId);
      setSecret(result.secret);
      void status.refetch();
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function copySecret() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); }
    catch { setError(true); }
  }
  if (status.error instanceof RelayApiError && status.error.status === 409) {
    return <p className="adm-form-hint">{t("automation.webhook_save_first")}</p>;
  }
  const info = status.data;
  const url = info ? `${backendPublicOrigin()}${info.path}` : "";
  return (
    <div className="webhook-panel">
      {info ? <>
        <p className="adm-form-hint">{t("automation.webhook_url")}</p>
        <code className="webhook-panel-url">{url}</code>
        <p className="adm-form-hint">{t("automation.webhook_header", { header: info.header })}</p>
        {info.configured && !secret ? <p className="adm-form-hint">{t("automation.webhook_configured")}</p> : null}
      </> : null}
      {secret ? <div className="webhook-panel-secret" role="status">
        <p>{t("automation.webhook_secret_once")}</p>
        <code>{secret}</code>
        <Button type="button" variant="outline" size="sm" onClick={() => void copySecret()}>{t("automation.webhook_copy")}</Button>
      </div> : null}
      {error || status.isError ? <p className="adm-form-error" role="alert">{t("automation.webhook_error")}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={pending || !info} onClick={() => void rotate()}>
        {t(info?.configured ? "automation.webhook_rotate" : "automation.webhook_generate")}
      </Button>
    </div>
  );
}
