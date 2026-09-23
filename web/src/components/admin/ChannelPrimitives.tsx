"use client";

import { type ReactNode, type RefObject } from "react";
import {
  AdminConnect,
  AdminEmployees,
  AdminLocked,
  AdminVerified,
  ICON,
} from "../icons";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ChatIntegration, ChatProvider, Tone } from "../../types";
/**
 * Channel presentation primitives, split out of a 1072-line ChannelsView.tsx:
 * the provider glyph and avatar, the status readiness derivation, the create
 * form, and the numbered section wrapper.
 *
 * Every one of these already had an explicit prop interface — they were
 * standalone components sharing a file with the view that renders them, not
 * with anything that reads its state.
 */

/** The credential a Telegram channel needs. Lives here with the form that
 *  renders it and the readiness check that reads it. */
export const TELEGRAM_CREDENTIAL_FIELDS = [
  { key: "botToken", secret: true, labelKey: "admin.v2.chat_field_bot_token" },
] as const;

export function providerLabel(provider: ChatProvider): string {
  return provider[0].toUpperCase() + provider.slice(1);
}

/** Ink-on-neutral provider mark — silhouette carries identity without vendor chroma. */
export function ProviderGlyph({ provider }: { provider: ChatProvider }) {
  if (provider === "discord") {
    return (
      <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.618-1.25.077.077 0 0 0-.078-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.319 13.58.099 18.058a.082.082 0 0 0 .031.056c2.053 1.508 4.042 2.423 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 12.2 12.2 0 0 1-1.872-.892.077.077 0 0 1-.007-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.198.373.292a.077.077 0 0 1-.007.128c-.598.343-1.22.644-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029c1.961-.607 3.95-1.522 6.002-3.03a.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.548-13.66a.061.061 0 0 0-.031-.029ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419s.955-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419s.955-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.419-2.157 2.419Z"
        />
      </svg>
    );
  }
  if (provider === "telegram") {
    return (
      <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M9.76 14.78 9.5 18.4c.36 0 .52-.15.71-.34l1.7-1.63 3.53 2.6c.65.36 1.11.17 1.28-.6l2.32-10.92h.01c.21-.97-.35-1.35-.98-1.11L4.2 10.54c-.94.37-.92.89-.16 1.13l3.56 1.11 8.27-5.21c.39-.25.74-.11.45.14z"
        />
      </svg>
    );
  }
  if (provider === "lark") {
    return (
      <svg viewBox="0 0 33 25.37" width="1em" height="1em" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M16.59 13.32c1.27-1.3 2.6-2.76 4.13-3.73.4-.32.83-.61 1.27-.88.64-.39 1.33-.7 2.05-.94-.66-2.59-1.87-5.02-3.54-7.11A1.87 1.87 0 0 0 19.05 0H5.37a.26.26 0 0 0-.16.47c4.67 3.42 8.54 7.82 11.34 12.89l.04-.04Z"
        />
        <path
          fill="currentColor"
          opacity="0.72"
          d="M11.15 25.37c7.07 0 13.23-3.9 16.43-9.66.11-.2.22-.41.33-.61a7.75 7.75 0 0 1-4.54 3.75 7.8 7.8 0 0 1-4.88.04c-1.98-.53-3.93-1.21-5.79-2.06C7.45 14.31 3.65 11.01.45 7.58A.26.26 0 0 0 0 7.76v12.08c0 .98.28 1.51.75 1.83a18.75 18.75 0 0 0 10.4 3.7Z"
        />
        <path
          fill="currentColor"
          opacity="0.45"
          d="M31.92 8.34a11.24 11.24 0 0 0-7.99-.6 12.5 12.5 0 0 0-4.03 2.31c-1.74 1.63-3.15 3.48-5.12 4.79-.6.4-1.22.75-1.86 1.08 2.2 1.08 4.57 1.94 6.97 2.46 2.77.6 5.66-.64 7.27-2.98l.75-1.23 1.65-3.3a10.5 10.5 0 0 1 2.36-2.53Z"
        />
      </svg>
    );
  }
  return null;
}

export function ProviderAvatar({ provider, size }: { provider: ChatProvider; size?: "lg" | "hero" }) {
  return (
    <span
      className={`adm-chat-avatar${size ? ` adm-chat-avatar--${size}` : ""}`}
      data-provider={provider}
      aria-hidden="true"
    >
      <ProviderGlyph provider={provider} />
    </span>
  );
}

// Canonical tone semantics (see lib/statusTone.ts): a healthy integration is
// good, a degraded one is warn (queued/impaired), and anything else — a draft,
// or one an operator switched off — is neutral. Disabled is a decision, not a
// fault: painting it --err made a deliberately paused channel read as broken,
// and a real fault already has its own channel in `health` (the "Bot token
// rejected" line under the name).
export function statusTone(status: ChatIntegration["status"]): Tone {
  if (status === "active") return "good";
  if (status === "degraded") return "warn";
  return "neutral";
}

export function readiness(integration: ChatIntegration): Array<{
  key: string;
  labelKey: string;
  ready: boolean;
  icon: typeof AdminLocked;
}> {
  return [
    ...(integration.provider === "telegram"
      ? [{
          key: "callback",
          labelKey: "admin.v2.chat_readiness_callback",
          ready: typeof integration.config.publicBaseUrl === "string",
          icon: AdminConnect,
        }]
      : []),
    { key: "secrets", labelKey: "admin.v2.chat_readiness_secrets", ready: integration.secretConfigured, icon: AdminLocked },
    { key: "links", labelKey: "admin.v2.chat_readiness_identity", ready: integration.identityLinkCount > 0, icon: AdminEmployees },
    { key: "allowlist", labelKey: "admin.v2.chat_readiness_allowlist", ready: integration.allowedConversationCount > 0, icon: AdminVerified },
  ];
}

export function normalizePublicBaseUrl(value: string): string | undefined {
  if (!value || /\s|\\/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== "/"
    ) {
      return undefined;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function ChannelCreateForm({
  displayName,
  tenantId,
  publicBaseUrl,
  credentials,
  busy,
  fieldErrors,
  displayNameRef,
  publicBaseUrlRef,
  credentialRef,
  onDisplayNameChange,
  onTenantIdChange,
  onPublicBaseUrlChange,
  onCredentialChange,
  onSubmit,
  submitLabel,
  onCancel,
  idPrefix = "chat",
}: {
  displayName: string;
  tenantId: string;
  publicBaseUrl: string;
  credentials: Record<string, string>;
  busy: boolean;
  fieldErrors: { displayName?: string; publicBaseUrl?: string; credential?: string };
  displayNameRef: RefObject<HTMLInputElement | null>;
  publicBaseUrlRef: RefObject<HTMLInputElement | null>;
  credentialRef: RefObject<HTMLInputElement | null>;
  onDisplayNameChange: (value: string) => void;
  onTenantIdChange: (value: string) => void;
  onPublicBaseUrlChange: (value: string) => void;
  onCredentialChange: (key: string, value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  onCancel?: () => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  return (
    <form
      className="adm-chat-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <Field label={t("admin.v2.chat_provider")} wrapper="div">
        <span className="adm-chat-provider-static">Telegram</span>
      </Field>
      <Field
        label={t("admin.v2.chat_display_name")}
        error={fieldErrors.displayName}
        errorId={`${idPrefix}-display-name-error`}
      >
        <Input
          ref={displayNameRef}
          data-modal-initial-focus
          name={`${idPrefix}-display-name`}
          autoComplete="organization"
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="Telegram Bot…"
          aria-invalid={Boolean(fieldErrors.displayName) || undefined}
          aria-describedby={fieldErrors.displayName ? `${idPrefix}-display-name-error` : undefined}
        />
      </Field>
      <Field label={t("admin.v2.chat_tenant")} optional={t("admin.v2.optional")}>
        <Input
          name={`${idPrefix}-tenant-id`}
          autoComplete="off"
          spellCheck={false}
          value={tenantId}
          onChange={(event) => onTenantIdChange(event.target.value)}
          placeholder={`${t("admin.v2.optional")}…`}
        />
      </Field>
      <Field
        label={t("admin.v2.chat_public_url")}
        hint={t("admin.v2.chat_public_url_help")}
        error={fieldErrors.publicBaseUrl}
        errorId={`${idPrefix}-public-base-url-error`}
      >
        <Input
          ref={publicBaseUrlRef}
          name={`${idPrefix}-public-base-url`}
          type="url"
          autoComplete="url"
          spellCheck={false}
          value={publicBaseUrl}
          onChange={(event) => onPublicBaseUrlChange(event.target.value)}
          placeholder="https://relay.example.com…"
          aria-invalid={Boolean(fieldErrors.publicBaseUrl) || undefined}
          aria-describedby={fieldErrors.publicBaseUrl ? `${idPrefix}-public-base-url-error` : undefined}
        />
      </Field>
      {TELEGRAM_CREDENTIAL_FIELDS.map((field) => (
        <Field
          key={field.key}
          label={t(field.labelKey)}
          error={fieldErrors.credential}
          errorId={`${idPrefix}-${field.key}-error`}
        >
          <Input
            ref={credentialRef}
            name={`${idPrefix}-${field.key}`}
            autoComplete={field.secret ? "new-password" : "off"}
            spellCheck={false}
            value={credentials[field.key] ?? ""}
            onChange={(event) => onCredentialChange(field.key, event.target.value)}
            type={field.secret ? "password" : "text"}
            placeholder={`${t(field.labelKey)}…`}
            aria-invalid={Boolean(fieldErrors.credential) || undefined}
            aria-describedby={fieldErrors.credential ? `${idPrefix}-${field.key}-error` : undefined}
          />
        </Field>
      ))}
      <small>{t("admin.v2.chat_telegram_secret_generated")}</small>
      {onCancel ? (
        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={busy} loadingLabel={t("admin.creating")}>
            <AdminConnect size={ICON.md} aria-hidden="true" />
            <span>{submitLabel}</span>
          </Button>
        </div>
      ) : (
        <Button type="submit" loading={busy} loadingLabel={t("admin.creating")}>
          <AdminConnect size={ICON.md} aria-hidden="true" />
          <span>{submitLabel}</span>
        </Button>
      )}
    </form>
  );
}

export function ChannelSection({
  title,
  step,
  children,
  className = "",
}: {
  title: string;
  step?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`adm-chat-section ${className}`.trim()}>
      <header className="adm-chat-section-head">
        {step ? <span className="adm-chat-section-step" aria-hidden="true">{step}</span> : null}
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}
