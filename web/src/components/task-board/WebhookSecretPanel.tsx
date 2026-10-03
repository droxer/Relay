"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RelayApiError, rotateWebhookSecret, webhookSecretStatus } from "../../api";
import { backendPublicOrigin } from "../../lib/apiOrigin";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/** How long a Copy button says "Copied" before it reads Copy again. */
const COPIED_MS = 2000;

export function WebhookSecretPanel({ taskId }: { taskId?: string }) {
  const { t } = useTranslation();
  if (!taskId) return <p className="adm-form-hint">{t("automation.webhook_save_first")}</p>;
  return <SavedWebhookPanel key={taskId} taskId={taskId} />;
}

function SavedWebhookPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const urlLabelId = useId();
  const secretLabelId = useId();
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  // Rotating stops the old secret at once, so a live secret takes a second click.
  const [confirming, setConfirming] = useState(false);
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
    setConfirming(false);
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
  if (status.error instanceof RelayApiError && status.error.status === 409) {
    return <p className="adm-form-hint">{t("automation.webhook_save_first")}</p>;
  }
  const info = status.data;
  const url = info ? `${backendPublicOrigin()}${info.path}` : "";
  return (
    <div className="webhook-panel">
      {info ? (
        <Field label={t("automation.webhook_url")} labelId={urlLabelId} wrapper="div" className="webhook-panel-field"
          hint={t("automation.webhook_header", { header: info.header })}>
          <CopyableValue value={url} onError={() => setError(true)} />
        </Field>
      ) : null}
      {secret ? (
        <div className="webhook-panel-field" role="status">
          <Field label={t("automation.webhook_secret")} labelId={secretLabelId} wrapper="div" className="webhook-panel-field"
            hint={t("automation.webhook_secret_once")}>
            <CopyableValue value={secret} onError={() => setError(true)} />
          </Field>
        </div>
      ) : info?.configured ? <p className="adm-form-hint">{t("automation.webhook_configured")}</p> : null}
      {error || status.isError ? <p className="adm-form-error" role="alert">{t("automation.webhook_error")}</p> : null}
      {/* One row in every state, so confirming does not reflow the panel. */}
      <div className="webhook-panel-actions">
        {confirming ? <>
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => void rotate()}>
            {t("automation.webhook_rotate_confirm")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("dialog.cancel")}</Button>
        </> : (
          <Button type="button" variant="outline" size="sm" disabled={pending || !info}
            onClick={() => (info?.configured ? setConfirming(true) : void rotate())}>
            {t(info?.configured ? "automation.webhook_rotate" : "automation.webhook_generate")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A read-only value with its own Copy button: the endpoint and the one-time secret. */
function CopyableValue({ value, onError }: { value: string; onError: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      onError();
    }
  }
  return (
    <div className="webhook-panel-value">
      <code>{value}</code>
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        {t(copied ? "automation.webhook_copied" : "automation.webhook_copy")}
      </Button>
    </div>
  );
}
