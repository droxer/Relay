"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActionAdd,
  AdminChannel,
  ICON,
} from "../icons";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { RelayEmptyState } from "../RelayEmptyState";
import { TonePill } from "../StatusPill";
import { Drawer } from "@/components/ui/Drawer";
import {
  activateChatIntegration,
  checkChatIntegration,
  createChatIntegration,
  listChatIntegrations,
  listControlPanelAgents,
  listControlPanelDaemonNodes,
} from "../../api";
import { backendPublicOrigin } from "../../lib/apiOrigin";
import { useUrlSearchState } from "../../hooks/useUrlSearchState";
import type { ChatIntegration } from "../../types";

import {
  ChannelCreateForm,
  normalizePublicBaseUrl,
  ProviderAvatar,
  providerLabel,
  statusTone,
  TELEGRAM_CREDENTIAL_FIELDS,
} from "./ChannelPrimitives";
import { ChannelDetail } from "./ChannelDetail";
import { Alert } from "@/components/ui/alert";

const CHAT_INTEGRATIONS_KEY = ["admin", "chat-integrations"] as const;

export function ChannelsView({
  createOpen: createOpenProp,
  onCreateOpenChange,
  onHasChannelsChange,
  showToolbarCreate = true,
}: {
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  onHasChannelsChange?: (hasChannels: boolean) => void;
  /** When false, Create lives only in an external header action (Channels route). */
  showToolbarCreate?: boolean;
} = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { confirm } = useDialogs();
  const [displayName, setDisplayName] = useState("Telegram Bot");
  const [tenantId, setTenantId] = useState("");
  // Chat providers post webhooks straight to the backend, so this defaults to
  // the backend origin rather than the page origin.
  const [publicBaseUrl, setPublicBaseUrl] = useState(() => backendPublicOrigin(""));
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useUrlSearchState<string | null>(
    "channel",
    null,
    (value) => value,
    (value) => value,
  );
  const [createFieldErrors, setCreateFieldErrors] = useState<{
    displayName?: string;
    publicBaseUrl?: string;
    credential?: string;
  }>({});
  const createDisplayNameRef = useRef<HTMLInputElement>(null);
  const createPublicBaseUrlRef = useRef<HTMLInputElement>(null);
  const createCredentialRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);

  const createControlled = createOpenProp !== undefined;
  const createOpen = createControlled ? Boolean(createOpenProp) : internalCreateOpen;

  function setCreateOpen(open: boolean) {
    if (!createControlled) setInternalCreateOpen(open);
    onCreateOpenChange?.(open);
  }

  const query = useQuery({
    queryKey: CHAT_INTEGRATIONS_KEY,
    queryFn: async ({ signal }) => (await listChatIntegrations(signal)).integrations,
  });
  const agentsQuery = useQuery({
    queryKey: ["admin", "agents"],
    queryFn: ({ signal }) => listControlPanelAgents(undefined, signal),
  });
  const nodesQuery = useQuery({
    queryKey: ["admin", "daemon-nodes"],
    queryFn: ({ signal }) => listControlPanelDaemonNodes(signal),
  });

  // Agents aren't owned by employees — the default agent for a chat identity is
  // resolved through the selected employee's computers (their nodes), matching
  // the Employees view. With no employee typed, any agent is a candidate.

  const integrations = (query.data ?? []).filter((integration) => integration.provider === "telegram");
  const selected = useMemo(
    () => integrations.find((integration) => integration.id === selectedId) ?? integrations[0] ?? null,
    [integrations, selectedId],
  );
  const hasChannels = integrations.length > 0;
  const activeCount = integrations.filter((integration) => integration.status === "active").length;
  const linkCount = integrations.reduce((sum, integration) => sum + integration.identityLinkCount, 0);

  useEffect(() => {
    onHasChannelsChange?.(hasChannels);
  }, [hasChannels, onHasChannelsChange]);

  useEffect(() => {
    if (!hasChannels && createOpen) {
      if (!createControlled) setInternalCreateOpen(false);
      onCreateOpenChange?.(false);
    }
  }, [hasChannels, createOpen, createControlled, onCreateOpenChange]);


  function mergeIntegration(updated: ChatIntegration) {
    queryClient.setQueryData<ChatIntegration[]>(CHAT_INTEGRATIONS_KEY, (prev) => {
      const current = prev ?? [];
      return [updated, ...current.filter((integration) => integration.id !== updated.id)];
    });
    setSelectedId(updated.id);
  }

  async function mutate(label: string, action: () => Promise<{ integration: ChatIntegration }>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      mergeIntegration(result.integration);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function provision(
    label: string,
    action: () => Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>,
  ) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      mergeIntegration(result.integration);
      setNotice(result.provisioning.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function clearCreateFieldError(field: "displayName" | "publicBaseUrl" | "credential") {
    setCreateFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  async function handleCreate() {
    const nextFieldErrors: typeof createFieldErrors = {};
    if (!displayName.trim()) nextFieldErrors.displayName = t("admin.v2.chat_error_name_required");
    const normalizedPublicBaseUrl = normalizePublicBaseUrl(publicBaseUrl.trim());
    if (!normalizedPublicBaseUrl) nextFieldErrors.publicBaseUrl = t("admin.v2.chat_error_public_url");
    const fields = TELEGRAM_CREDENTIAL_FIELDS;
    const missing = fields.find((field) => !credentials[field.key]?.trim());
    if (missing) {
      nextFieldErrors.credential = t("admin.v2.chat_error_field_required", { field: t(missing.labelKey) });
    }
    setCreateFieldErrors(nextFieldErrors);
    const firstInvalid = nextFieldErrors.displayName
      ? createDisplayNameRef
      : nextFieldErrors.publicBaseUrl
        ? createPublicBaseUrlRef
        : nextFieldErrors.credential
          ? createCredentialRef
          : null;
    if (firstInvalid) {
      firstInvalid.current?.focus();
      return;
    }
    const config = Object.fromEntries(
      fields.filter((field) => !field.secret).map((field) => [field.key, credentials[field.key].trim()]),
    );
    const secrets = Object.fromEntries(
      fields.filter((field) => field.secret).map((field) => [field.key, credentials[field.key].trim()]),
    );
    const created = await mutate("create", () => createChatIntegration({
      provider: "telegram",
      displayName: displayName.trim(),
      tenantId: tenantId.trim() || undefined,
      secrets,
      config: {
        commandName: "relay",
        ...(normalizedPublicBaseUrl ? { publicBaseUrl: normalizedPublicBaseUrl } : {}),
        ...config,
      },
    }));
    if (!created) return;
    setCredentials({});
    setCreateOpen(false);
  }







  const createFormProps = {
    displayName,
    tenantId,
    publicBaseUrl,
    credentials,
    busy: busy !== null,
    fieldErrors: createFieldErrors,
    displayNameRef: createDisplayNameRef,
    publicBaseUrlRef: createPublicBaseUrlRef,
    credentialRef: createCredentialRef,
    onDisplayNameChange: (value: string) => {
      setDisplayName(value);
      clearCreateFieldError("displayName");
    },
    onTenantIdChange: setTenantId,
    onPublicBaseUrlChange: (value: string) => {
      setPublicBaseUrl(value);
      clearCreateFieldError("publicBaseUrl");
    },
    onCredentialChange: (key: string, value: string) => {
      setCredentials((current) => ({ ...current, [key]: value }));
      clearCreateFieldError("credential");
    },
    onSubmit: () => void handleCreate(),
    submitLabel: t("admin.v2.chat_create"),
  };

  const alerts = (
    <>
      {error ? (
        <Alert className="mb-4" aria-live="polite">
          {t("admin.v2.action_failed", { message: error })}
        </Alert>
      ) : null}
      {notice ? (
        <p className="adm-view-notice" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {query.error ? (
        <Alert className="mb-4" render={<div />}>
          <span>{t("admin.v2.chat_load_error")}</span>{" "}
          <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
            {t("admin.v2.retry")}
          </Button>
        </Alert>
      ) : null}
    </>
  );

  if (query.isLoading) {
    return (
      <div className="adm-view adm-chat" role="status" aria-busy="true">
        <span className="sr-only">{t("admin.v2.dash_loading")}</span>
        {alerts}
        <div className="workspace-skeleton-pane" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className={`workspace-skeleton workspace-skeleton-line${index === 2 ? " short" : ""}`}
            />
          ))}
        </div>
      </div>
    );
  }

  // Failed load with nothing cached: show only the error + retry, never the
  // zeroed stats and empty master/detail scaffold on top of the failure.
  if (query.error && !hasChannels) {
    return <div className="adm-view adm-chat">{alerts}</div>;
  }

  if (!query.error && !hasChannels) {
    return (
      <div className="adm-view adm-chat">
        {alerts}
        <div className="adm-chat-stage">
          <div className="adm-chat-stage-intro">
            <div className="adm-chat-stage-mark">
              <ProviderAvatar provider="telegram" size="hero" />
            </div>
            <RelayEmptyState
              className="adm-chat-stage-empty"
              title={t("admin.v2.chat_stage_title")}
              body={t("admin.v2.chat_stage_body")}
              titleId="channels-stage-title"
            />
          </div>
          <div className="adm-chat-stage-form">
            <ChannelCreateForm {...createFormProps} idPrefix="chat" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="adm-view adm-chat">
      {alerts}

      <div className="adm-chat-toolbar">
        <div className="adm-chat-metrics" role="group" aria-label={t("admin.v2.chat_metrics_label")}>
          <span className="adm-chat-metric">
            <span className="adm-chat-metric-label">{t("admin.v2.chat_metric_channels")}</span>
            <strong className="adm-chat-metric-value tnum">{integrations.length}</strong>
          </span>
          <span className="adm-chat-metric">
            <span className="adm-chat-metric-label">{t("admin.v2.chat_metric_active")}</span>
            <strong className="adm-chat-metric-value tnum">{activeCount}</strong>
          </span>
          <span className="adm-chat-metric">
            <span className="adm-chat-metric-label">{t("admin.v2.chat_metric_links")}</span>
            <strong className="adm-chat-metric-value tnum">{linkCount}</strong>
          </span>
        </div>
        {showToolbarCreate ? (
          // The shared list-header create affordance, same as every other
          // list page (see .page-header-icon-action, shell.css).
          <Button
            type="button"
            variant="ghost"
            className="page-header-icon-action page-header-icon-action--primary"
            tooltip={t("admin.v2.chat_create")}
            onClick={() => setCreateOpen(true)}
            disabled={busy !== null}
          >
            <ActionAdd size={ICON.md} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div className="adm-chat-grid">
        <section className="adm-chat-panel adm-chat-panel--list">
          <header className="adm-chat-panel-head">
            <AdminChannel size={ICON.lg} aria-hidden="true" />
            <div>
              <h2>{t("admin.v2.chat_existing_title")}</h2>
              <p>{t("admin.v2.chat_existing_sub")}</p>
            </div>
          </header>
          <div className="adm-chat-integration-list">
            {integrations.map((integration) => {
              const active = selected?.id === integration.id;
              return (
                <Button
                  variant="ghost"
                  key={integration.id}
                  type="button"
                  className="adm-chat-integration"
                  data-active={active ? "true" : "false"}
                  onClick={() => setSelectedId(integration.id)}
                >
                  <ProviderAvatar provider={integration.provider} />
                  <span className="adm-chat-integration-main">
                    <strong>{integration.displayName}</strong>
                    <span>
                      {providerLabel(integration.provider)}
                      {integration.tenantId ? <> · <span className="code">{integration.tenantId}</span></> : null}
                    </span>
                  </span>
                  <TonePill
                    tone={statusTone(integration.status)}
                    label={t(`admin.v2.chat_status_${integration.status}`, { defaultValue: integration.status })}
                    live={statusTone(integration.status) === "info"}
                  />
                </Button>
              );
            })}
          </div>
        </section>

        <ChannelDetail
          selected={selected}
          agents={agentsQuery.data?.agents}
          nodes={nodesQuery.data?.nodes}
          busy={busy !== null}
          mutate={mutate}
          provision={provision}
          confirm={confirm}
          onError={setError}
          onCheck={() => void mutate("check", () => checkChatIntegration(selected!.id))}
          onActivate={() => void provision("activate", () => activateChatIntegration(selected!.id))}
        />
      </div>

      <Drawer
        open={createOpen && hasChannels}
        onClose={() => setCreateOpen(false)}
        kicker={t("admin.v2.chat_eyebrow")}
        title={t("admin.v2.chat_new_title")}
        subtitle={t("admin.v2.chat_new_sub")}
        closeLabel={t("drawer.close")}
        bodyClassName="adm-drawer-body--column"
        width="form"
      >
        <ChannelCreateForm {...createFormProps} idPrefix="chat-drawer" onCancel={() => setCreateOpen(false)} />
      </Drawer>
    </div>
  );
}
