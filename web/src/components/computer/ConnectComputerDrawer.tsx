"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createLocalDeviceEnrollment } from "../../api";
import type { ControlPanelDaemonNodeRecord, CreateLocalDeviceEnrollmentResponse } from "../../types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Drawer } from "@/components/ui/Drawer";
import { CredCopyRow } from "../admin/CredCopyRow";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { isNodeOnline } from "../../lib/adminHelpers";
import { Alert } from "@/components/ui/alert";

interface ConnectComputerDrawerProps {
  open: boolean;
  nodes?: readonly ControlPanelDaemonNodeRecord[];
  onClose: () => void;
  /** Fires once the node exists on the backend, so the caller can merge it into the roster right away. */
  onConnected: (result: CreateLocalDeviceEnrollmentResponse) => void;
}

/**
 * Self-service registration of the employee's own machine — the counterpart
 * to admin's AssignNodeDrawer, but scoped to the caller's own device: no
 * employee picker, no "assign an existing node" branch, just "connect this
 * one" against POST /daemon-node-enrollments/local.
 *
 * A personal computer runs its agents directly, so there is no runtime to
 * pick here: BoxLite isolation is provisioned on admin-owned hardware, and
 * offering it as a choice to the person at the keyboard only invited them to
 * ask their own laptop for a sandbox it was never set up to boot.
 */
export function ConnectComputerDrawer({ open, onClose, onConnected, nodes = [] }: ConnectComputerDrawerProps) {
  const { t } = useTranslation();
  const [workspacePath, setWorkspacePath] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [result, setResult] = useState<CreateLocalDeviceEnrollmentResponse | null>(null);
  // Stable POSIX default for SSR/first render; the platform-specific value is
  // resolved after mount so the placeholder never hydration-mismatches.
  const [pathPlaceholder, setPathPlaceholder] = useState("/Users/alice/project");
  const { copiedField, copy } = useCopyFeedback();
  const workspacePathRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const hasUnsavedChanges = !result && (Boolean(workspacePath.trim()) || Boolean(displayName.trim()));
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  useEffect(() => {
    if (open) {
      setWorkspacePath("");
      setDisplayName("");
      setFieldError(null);
      setError(null);
      setIsBusy(false);
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    setPathPlaceholder(workspacePathPlaceholder());
  }, []);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPath = workspacePath.trim();
    if (!trimmedPath || !isAbsolutePath(trimmedPath)) {
      setFieldError(t("computer.connect_workspace_path_error"));
      workspacePathRef.current?.focus();
      return;
    }
    setFieldError(null);
    setError(null);
    setIsBusy(true);
    try {
      const response = await createLocalDeviceEnrollment({
        workspacePath: trimmedPath,
        displayName: displayName.trim() || undefined,
      });
      setResult(response);
      onConnected(response);
    } catch (err) {
      setError(t("computer.connect_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  const token = result?.nodeToken ?? result?.sandboxToken;
  const liveNode = result ? nodes.find((node) => node.id === result.node.id) : undefined;
  const connected = Boolean(liveNode && isNodeOnline(liveNode));

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("computer.title")}
      title={t("computer.connect_title")}
      subtitle={result ? t("computer.connect_success_sub") : t("computer.connect_sub")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      {result ? (
        <div className="adm-form" ref={resultRef} tabIndex={-1}>
          <p className="adm-cred-note">
            {result.reused ? t("computer.connect_success_existing") : t("computer.connect_success")}
          </p>
          <ol className="computer-install-steps">
            <li>
              <section aria-labelledby="computer-install-command-title">
                <h3 id="computer-install-command-title">{t(result.installCommand ? "computer.connect_command_step" : "admin.daemon_command")}</h3>
                <CredCopyRow
                  label={t(result.installCommand ? "computer.connect_setup_label" : "admin.daemon_command")}
                  hint={t("computer.connect_setup_hint")}
                  value={result.installCommand ?? result.daemonCommand ?? ""}
                  copyLabel={t("computer.connect_setup_copy")}
                  copied={copiedField === "setup"}
                  onCopy={() => void copy("setup", result.installCommand ?? result.daemonCommand ?? "")}
                />
                {!result.installCommand ? <Alert>{t("computer.connect_legacy_hint")}</Alert> : null}
              </section>
            </li>
            <li>
              <section aria-labelledby="computer-install-token-title">
                <h3 id="computer-install-token-title">{t("computer.connect_token_step")}</h3>
                {token ? (
                  <CredCopyRow
                    label={t("admin.node_token")}
                    hint={t("computer.connect_token_prompt")}
                    value={token}
                    copyLabel={t("admin.copy_node_token")}
                    copied={copiedField === "node-token"}
                    onCopy={() => void copy("node-token", token)}
                  />
                ) : null}
                <p className="adm-cred-note">
                  {token ? t("computer.connect_token_once") : t("computer.connect_token_on_device")}
                </p>
              </section>
            </li>
          </ol>
          <div className="computer-install-status" role="status" data-connected={connected}>
            <strong>{t(connected ? "computer.connect_online" : "computer.connect_waiting")}</strong>
            <p>{t(connected ? "computer.connect_online_hint" : "computer.connect_waiting_hint")}</p>
          </div>
          <details className="computer-install-details">
            <summary>{t("computer.connect_details")}</summary>
            <CredCopyRow
              label={t("admin.node_id")}
              value={result.node.id}
              copyLabel={t("admin.copy_node_id")}
              copied={copiedField === "node-id"}
              onCopy={() => void copy("node-id", result.node.id)}
            />
          </details>
          <div className="adm-form-actions">
            <Button size="cta" type="button" onClick={onClose}>
              {t("admin.v2.close_drawer")}
            </Button>
          </div>
        </div>
      ) : (
        <form className="adm-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="computer-install-intro">
            <h3>{t("computer.connect_intro_title")}</h3>
            <p>{t("computer.connect_intro_body")}</p>
            <p className="adm-form-hint">{t("computer.connect_requirements")}</p>
          </div>
          <fieldset className="adm-form-section">
            <Field label={t("computer.connect_name_label")} optional={t("admin.v2.optional")}>
              <Input
                name="connect-computer-display-name"
                autoComplete="off"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("admin.v2.computer_name_placeholder_local")}
                maxLength={64}
                disabled={isBusy}
              />
            </Field>
            <Field
              label={t("nav.workspace_label")}
              hint={t("computer.connect_workspace_hint")}
              error={fieldError ?? undefined}
              errorId="connect-computer-workspace-path-error"
            >
              <Input
                ref={workspacePathRef}
                name="connect-computer-workspace-path"
                autoComplete="off"
                spellCheck={false}
                value={workspacePath}
                onChange={(event) => {
                  setWorkspacePath(event.target.value);
                  if (fieldError) setFieldError(null);
                }}
                placeholder={pathPlaceholder}
                disabled={isBusy}
                aria-invalid={Boolean(fieldError) || undefined}
                aria-describedby={fieldError ? "connect-computer-workspace-path-error" : undefined}
                data-modal-initial-focus
              />
            </Field>
            {/* Agents run as plain processes against the installs already on
                this machine. */}
            <p className="adm-form-hint">{t("computer.connect_run_hint")}</p>
          </fieldset>

          {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

          <div className="adm-form-actions">
            <Button size="cta" type="button" variant="ghost" onClick={() => { void requestClose(); }} disabled={isBusy}>
              {t("admin.v2.cancel")}
            </Button>
            <Button size="cta" type="submit" loading={isBusy}>
              {isBusy ? t("computer.connect_connecting") : t("computer.connect_action")}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

function workspacePathPlaceholder(): string {
  if (typeof navigator !== "undefined" && /Linux/i.test(navigator.platform)) {
    return "/home/alice/project";
  }
  return "/Users/alice/project";
}
