"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addChatAllowedConversation,
  addChatIdentityLink,
  deleteChatAllowedConversation,
  deleteChatIdentityLink,
  rotateTelegramWebhookSecret,
  updateChatIntegration,
} from "../../api";
import type { ChatIntegration, EmployeeAgent, DaemonNodeMonitorRecord } from "../../types";
import { agentsOnNodes } from "../../lib/adminHelpers";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RosterAgentItem, RosterTriggerValue } from "../roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "../roster/RosterTabs";
import { AdminDelete, ICON } from "../icons";
import { RelayEmptyState } from "../RelayEmptyState";
import { TonePill } from "../StatusPill";
import {
  ChannelSection,
  normalizePublicBaseUrl,
  ProviderAvatar,
  readiness,
  statusTone,
  TELEGRAM_CREDENTIAL_FIELDS,
} from "./ChannelPrimitives";

/**
 * The right-hand panel of the Channels view: everything about the ONE selected
 * integration — its health, connection settings, identity links, and allowed
 * conversations.
 *
 * Split out of a 1072-line ChannelsView.tsx. The panel owns its own EDITING
 * state (the connection fields, the two add-forms) rather than taking it as
 * props: that state has no reader outside this panel, and hoisting it into the
 * view was what made the view long. What crosses the seam is only what is
 * genuinely shared — the selection, the two mutation helpers, and the
 * view-level busy/error channels.
 */
export interface ChannelDetailProps {
  selected: ChatIntegration | undefined;
  agents: EmployeeAgent[] | undefined;
  nodes: DaemonNodeMonitorRecord[] | undefined;
  busy: boolean;
  mutate: (label: string, action: () => Promise<{ integration: ChatIntegration }>) => Promise<unknown>;
  /** Health check and activation, both view-level provisioning calls. */
  onCheck: () => void;
  onActivate: () => void;
  provision: (
    label: string,
    action: () => Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>,
  ) => Promise<unknown>;
  confirm: (options: {
    title: string;
    message?: string;
    confirmLabel?: string;
    tone?: "danger";
  }) => Promise<boolean>;
  onError: (message: string) => void;
}

export function ChannelDetail({
  selected,
  agents: agentRecords,
  nodes,
  busy,
  mutate,
  provision,
  confirm,
  onError,
  onCheck,
  onActivate,
}: ChannelDetailProps) {
  const { t } = useTranslation();
  const [editPublicBaseUrl, setEditPublicBaseUrl] = useState("");
  const [editCredentials, setEditCredentials] = useState<Record<string, string>>({});
  const [identityForm, setIdentityForm] = useState({
    externalUserId: "",
    employeeId: "",
    displayName: "",
    defaultAgentId: "",
  });
  const [conversationForm, setConversationForm] = useState({
    conversationId: "",
    threadId: "",
    label: "",
  });

  useEffect(() => {
    if (!selected) return;
    setEditPublicBaseUrl(
      typeof selected.config.publicBaseUrl === "string" ? selected.config.publicBaseUrl : "",
    );
    setEditCredentials(Object.fromEntries(
      TELEGRAM_CREDENTIAL_FIELDS
        .filter((field) => !field.secret)
        .map((field) => {
          const value = selected.config[field.key];
          return [field.key, typeof value === "string" ? value : ""];
        }),
    ));
  }, [selected]);

  const identityAgentOptions = useMemo(() => {
    const agents = (agentRecords ?? []).filter((agent) => !agent.deletedAt);
    const employeeId = identityForm.employeeId.trim();
    if (!employeeId) return agents;
    const nodeIds = (nodes ?? [])
      .filter((node) => node.employeeId === employeeId)
      .map((node) => node.id);
    return agentsOnNodes(nodeIds, agents);
  }, [agentRecords, nodes, identityForm.employeeId]);

  // A channel identity routes to one agent, so this picker offers a single
  // roster and the shared picker draws no tab strip for it. If a channel ever
  // routes to a team, add its tab here and the strip appears.
  const rosterTabs: RosterTab<"agents">[] = [
    { id: "agents", label: t("admin.v2.chat_agent_placeholder"), count: identityAgentOptions.length },
  ];
  const roster = useRosterTabs({
    tabs: rosterTabs,
    activeTab: "agents",
    label: t("admin.v2.chat_agent_placeholder"),
  });

  async function onAddIdentity() {
    if (!selected) return;
    if (!identityForm.externalUserId.trim() || !identityForm.employeeId.trim()) {
      onError(t("admin.v2.chat_identity_required"));
      return;
    }
    await mutate("identity", () => addChatIdentityLink(selected.id, {
      externalUserId: identityForm.externalUserId,
      employeeId: identityForm.employeeId,
      displayName: identityForm.displayName || undefined,
      defaultAgentId: identityForm.defaultAgentId || undefined,
    }));
    setIdentityForm({ externalUserId: "", employeeId: "", displayName: "", defaultAgentId: "" });
  }

  async function onAddConversation() {
    if (!selected) return;
    await mutate("conversation", () => addChatAllowedConversation(selected.id, {
      conversationId: conversationForm.conversationId,
      threadId: conversationForm.threadId || undefined,
      label: conversationForm.label || undefined,
    }));
    setConversationForm({ conversationId: "", threadId: "", label: "" });
  }

  async function onDeleteIdentityLink(link: ChatIntegration["identityLinks"][number]) {
    if (!selected) return;
    const ok = await confirm({
      title: t("admin.v2.chat_delete_link_confirm", { id: link.externalUserId }),
      message: t("admin.v2.chat_delete_link_message"),
      confirmLabel: t("admin.v2.chat_delete_link"),
      tone: "danger",
    });
    if (!ok) return;
    await mutate("delete-link", () => deleteChatIdentityLink(selected.id, link.id));
  }

  async function onDeleteConversation(conversation: ChatIntegration["allowedConversations"][number]) {
    if (!selected) return;
    const ok = await confirm({
      title: t("admin.v2.chat_delete_allow_confirm", { id: conversation.conversationId }),
      message: t("admin.v2.chat_delete_allow_message"),
      confirmLabel: t("admin.v2.chat_delete_allow"),
      tone: "danger",
    });
    if (!ok) return;
    await mutate(
      "delete-conversation",
      () => deleteChatAllowedConversation(selected.id, conversation.id),
    );
  }

  async function onUpdateConnection() {
    if (!selected) return;
    const normalizedPublicBaseUrl = normalizePublicBaseUrl(editPublicBaseUrl.trim());
    if (!normalizedPublicBaseUrl) {
      onError(t("admin.v2.chat_error_public_url"));
      return;
    }
    const fields = TELEGRAM_CREDENTIAL_FIELDS;
    const missingPublicField = fields.find((field) => !field.secret && !editCredentials[field.key]?.trim());
    if (missingPublicField) {
      onError(t("admin.v2.chat_error_field_required", { field: t(missingPublicField.labelKey) }));
      return;
    }
    const config = {
      ...selected.config,
      ...(normalizedPublicBaseUrl ? { publicBaseUrl: normalizedPublicBaseUrl } : {}),
      ...Object.fromEntries(
        fields.filter((field) => !field.secret).map((field) => [field.key, editCredentials[field.key].trim()]),
      ),
    };
    const secrets = Object.fromEntries(
      fields
        .filter((field) => field.secret && editCredentials[field.key]?.trim())
        .map((field) => [field.key, editCredentials[field.key].trim()]),
    );
    await mutate("update", () => updateChatIntegration(selected.id, {
      config,
      ...(Object.keys(secrets).length ? { secrets } : {}),
    }));
    setEditCredentials((current) => Object.fromEntries(
      Object.entries(current).map(([key, value]) => [
        key,
        fields.some((field) => field.key === key && field.secret) ? "" : value,
      ]),
    ));
  }

  async function onRotateWebhookSecret() {
    if (!selected) return;
    const ok = await confirm({
      title: t("admin.v2.chat_rotate_confirm", {
        defaultValue: "Rotate the webhook secret? The current secret stops working immediately.",
      }),
      message: t("admin.v2.chat_rotate_message"),
      confirmLabel: t("admin.v2.chat_rotate_webhook_secret"),
      tone: "danger",
    });
    if (!ok) return;
    await provision("rotate-secret", () => rotateTelegramWebhookSecret(selected.id));
  }

  return (
<section className="adm-chat-panel adm-chat-panel--detail">
  {selected ? (
    <>
      <header className="adm-chat-panel-head adm-chat-panel-head--detail">
        <ProviderAvatar provider={selected.provider} size="lg" />
        <div>
          <h2>{selected.displayName}</h2>
          <p>{selected.health.message}</p>
        </div>
        <TonePill
          tone={statusTone(selected.status)}
          label={t(`admin.v2.chat_status_${selected.status}`, { defaultValue: selected.status })}
          live={statusTone(selected.status) === "info"}
        />
      </header>

      <div className="adm-chat-readiness" role="list" aria-label={t("admin.v2.chat_readiness_label")}>
        {readiness(selected).map((item) => {
          const Icon = item.icon;
          return (
            <span
              key={item.key}
              role="listitem"
              className={`adm-chat-ready ${item.ready ? "ready" : ""}`}
            >
              <Icon size={ICON.sm} aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </span>
          );
        })}
      </div>

      <ChannelSection title={t("admin.v2.chat_connection_title")} step="1">
        <div className="adm-chat-form compact adm-chat-connection-form">
          {selected.provider === "telegram" ? (
            <Field label={t("admin.v2.chat_public_url")}>
              <Input
                name="chat-edit-public-base-url"
                type="url"
                autoComplete="url"
                spellCheck={false}
                value={editPublicBaseUrl}
                onChange={(event) => setEditPublicBaseUrl(event.target.value)}
              />
            </Field>
          ) : null}
          {TELEGRAM_CREDENTIAL_FIELDS.map((field) => (
            <Field key={field.key} label={t(field.labelKey)}>
              <Input
                name={`chat-edit-${field.key}`}
                autoComplete={field.secret ? "new-password" : "off"}
                spellCheck={false}
                type={field.secret ? "password" : "text"}
                value={editCredentials[field.key] ?? ""}
                onChange={(event) =>
                  setEditCredentials((current) => ({ ...current, [field.key]: event.target.value }))
                }
                placeholder={field.secret ? t("admin.v2.chat_secret_unchanged") : undefined}
              />
            </Field>
          ))}
          <div className="adm-chat-section-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void onUpdateConnection()}
              disabled={busy}
            >
              {t("admin.v2.chat_save_connection")}
            </Button>
            {selected.provider === "telegram" ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void onRotateWebhookSecret()}
                disabled={busy}
              >
                {t("admin.v2.chat_rotate_webhook_secret")}
              </Button>
            ) : null}
          </div>
        </div>
      </ChannelSection>

      <ChannelSection title={t("admin.v2.chat_live_title")} step="2">
        <div className="adm-chat-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void onCheck()}
            disabled={busy}
          >
            {t("admin.v2.chat_check")}
          </Button>
          <Button
            type="button"
            onClick={() => void onActivate()}
            disabled={busy || selected.status === "active"}
          >
            {t("admin.v2.chat_activate")}
          </Button>
        </div>
        {selected.provider === "telegram" && typeof selected.config.publicBaseUrl === "string" ? (
          <div className="adm-chat-callback">
            <strong>{t("admin.v2.chat_callback_url")}</strong>
            <code>
              {`${String(selected.config.publicBaseUrl).replace(/\/+$/, "")}/webhooks/${selected.provider}/${selected.id}`}
            </code>
            <small>{t(`admin.v2.chat_callback_help_${selected.provider}`)}</small>
          </div>
        ) : null}
      </ChannelSection>

      <div className="adm-chat-split">
        <ChannelSection title={t("admin.v2.chat_links_title")} step="3">
          <div className="adm-chat-form compact">
            <Input
              name="chat-external-user-id"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("admin.v2.chat_external_user")}
              value={identityForm.externalUserId}
              onChange={(event) =>
                setIdentityForm((prev) => ({ ...prev, externalUserId: event.target.value }))
              }
              placeholder={`${t("admin.v2.chat_external_user")}…`}
            />
            <Input
              name="chat-employee-id"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("admin.v2.placeholder_employee_id")}
              value={identityForm.employeeId}
              onChange={(event) =>
                setIdentityForm((prev) => ({
                  ...prev,
                  employeeId: event.target.value,
                  defaultAgentId: "",
                }))
              }
              placeholder={`${t("admin.v2.placeholder_employee_id")}…`}
            />
            <Select
              name="chat-default-agent-id"
              value={identityForm.defaultAgentId || null}
              onValueChange={(value) =>
                setIdentityForm((prev) => ({ ...prev, defaultAgentId: value ?? "" }))
              }
              onOpenChange={(open) => { if (open) roster.resetTab(); }}
            >
              <SelectTrigger
                className="w-full"
                aria-label={t("admin.v2.chat_agent_placeholder")}
              >
                <SelectValue placeholder={t("admin.v2.chat_agent_placeholder")}>
                  {(value: string | null) => {
                    if (!value) return t("admin.v2.chat_agent_placeholder");
                    const agent = identityAgentOptions.find((a) => a.id === value);
                    return agent ? <RosterTriggerValue agent={agent} /> : value;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                onKeyDownCapture={roster.onKeyDownCapture}
                header={roster.header}
              >
                <SelectGroup aria-label={rosterLabel(rosterTabs, roster.tab)}>
                  {identityAgentOptions.map((agent) => (
                    <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void onAddIdentity()}
              disabled={busy}
            >
              {t("admin.v2.chat_add_link")}
            </Button>
          </div>
          <ul className="adm-chat-rows">
            {selected.identityLinks.map((link) => (
              <li key={link.id}>
                <span>
                  <strong translate="no">@{link.employeeId}</strong>
                  <small className="code" translate="no">{link.externalUserId}</small>
                </span>
                <Button
                  variant="ghost"
                  danger
                  type="button"
                  onClick={() => void onDeleteIdentityLink(link)}
                  aria-label={t("admin.v2.chat_delete_link")}
                >
                  <AdminDelete size={ICON.sm} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </ChannelSection>

        <ChannelSection title={t("admin.v2.chat_allow_title")} step="4">
          <div className="adm-chat-form compact">
            <Input
              name="chat-conversation-id"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("admin.v2.chat_conversation_id")}
              value={conversationForm.conversationId}
              onChange={(event) =>
                setConversationForm((prev) => ({ ...prev, conversationId: event.target.value }))
              }
              placeholder={`${t("admin.v2.chat_conversation_id")}…`}
            />
            <Input
              name="chat-thread-id"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("admin.v2.chat_thread_optional")}
              value={conversationForm.threadId}
              onChange={(event) =>
                setConversationForm((prev) => ({ ...prev, threadId: event.target.value }))
              }
              placeholder={`${t("admin.v2.chat_thread_optional")}…`}
            />
            <Input
              name="chat-conversation-label"
              autoComplete="off"
              aria-label={t("admin.v2.chat_label")}
              value={conversationForm.label}
              onChange={(event) =>
                setConversationForm((prev) => ({ ...prev, label: event.target.value }))
              }
              placeholder={`${t("admin.v2.chat_label")}…`}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => void onAddConversation()}
              disabled={busy}
            >
              {t("admin.v2.chat_add_allow")}
            </Button>
          </div>
          <ul className="adm-chat-rows">
            {selected.allowedConversations.map((conversation) => (
              <li key={conversation.id}>
                <span>
                  <strong>{conversation.label}</strong>
                  <small className="code" translate="no">{conversation.conversationId}</small>
                </span>
                <Button
                  variant="ghost"
                  danger
                  type="button"
                  onClick={() => void onDeleteConversation(conversation)}
                  aria-label={t("admin.v2.chat_delete_allow")}
                >
                  <AdminDelete size={ICON.sm} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </ChannelSection>
      </div>
    </>
  ) : (
    <RelayEmptyState
      fill
      title={t("admin.v2.chat_select_empty")}
      body={t("admin.v2.chat_select_empty_body")}
      titleId="channels-select-empty"
    />
  )}
</section>
  );
}
