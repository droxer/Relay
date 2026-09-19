"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RelayApiError, reissueComputerToken, revealComputerToken } from "../../api";
import type { ComputerTokenResponse, ControlPanelDaemonNodeRecord } from "../../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { CredCopyRow } from "../admin/CredCopyRow";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { Alert } from "@/components/ui/alert";

interface ComputerTokenDrawerProps {
  open: boolean;
  onClose: () => void;
  node: ControlPanelDaemonNodeRecord | null;
}

/**
 * The launch token for one of the employee's own computers, on demand.
 *
 * Enrollment shows the token once; this drawer is the "sometimes I need it
 * again" surface — reveal reads the persisted secret, reissue rotates it when
 * the reader would rather burn the old one (lost, pasted somewhere public,
 * or the computer predates persistence and has nothing to reveal).
 */
export function ComputerTokenDrawer({ open, onClose, node }: ComputerTokenDrawerProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { copiedField, copy } = useCopyFeedback();
  const [credentials, setCredentials] = useState<ComputerTokenResponse | null>(null);
  const [unrecoverable, setUnrecoverable] = useState(false);
  const [reissued, setReissued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reveal" | "reissue" | null>(null);
  const credentialsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setCredentials(null);
      setUnrecoverable(false);
      setReissued(false);
      setError(null);
      setBusy(null);
    }
  }, [open]);

  // The Reveal button unmounts once credentials arrive; move focus onto the
  // revealed block instead of letting it drop to document.body.
  useEffect(() => {
    if (credentials) credentialsRef.current?.focus();
  }, [credentials]);

  if (!node) return null;

  async function handleReveal() {
    setBusy("reveal");
    setError(null);
    try {
      const response = await revealComputerToken(node!.id);
      setCredentials(response);
      setUnrecoverable(false);
      setReissued(false);
    } catch (err) {
      if (err instanceof RelayApiError && err.status === 409) {
        setCredentials(null);
        setUnrecoverable(true);
      } else {
        setError(t("computer.token_error", { message: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleReissue() {
    const confirmed = await confirm({
      title: t("computer.token_reissue_title"),
      message: t("computer.token_reissue_message"),
      confirmLabel: t("computer.token_reissue_action"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy("reissue");
    setError(null);
    try {
      const response = await reissueComputerToken(node!.id);
      setCredentials(response);
      setUnrecoverable(false);
      setReissued(true);
    } catch (err) {
      setError(t("computer.token_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      kicker={t("computer.title")}
      title={t("computer.token_title")}
      subtitle={`${node.displayName?.trim() || t("computer.unnamed")} · ${node.id}`}
      subtitleMono
      width="detail"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <div className="adm-form" ref={credentialsRef} tabIndex={-1}>
        {credentials ? (
          <>
            {reissued ? (
              <p className="adm-cred-note">{t("computer.token_reissued_note")}</p>
            ) : null}
            {credentials.installCommand || credentials.daemonCommand ? (
              <CredCopyRow
                label={t(credentials.installCommand ? "computer.connect_setup_label" : "admin.daemon_command")}
                hint={t(credentials.installCommand ? "computer.connect_setup_hint" : "admin.daemon_command_hint")}
                value={credentials.installCommand ?? credentials.daemonCommand!}
                copyLabel={t(credentials.installCommand ? "computer.connect_setup_copy" : "admin.copy_daemon_command")}
                copied={copiedField === "command"}
                onCopy={() => void copy("command", credentials.installCommand ?? credentials.daemonCommand!)}
              />
            ) : null}
            <CredCopyRow
              label={t("admin.node_token")}
              hint={credentials.installCommand ? t("computer.connect_token_prompt") : undefined}
              value={credentials.nodeToken}
              copyLabel={t("admin.copy_node_token")}
              copied={copiedField === "node-token"}
              onCopy={() => void copy("node-token", credentials.nodeToken)}
            />
          </>
        ) : (
          <p className="adm-cred-note">
            {unrecoverable ? t("computer.token_unrecoverable") : t("computer.token_hidden_note")}
          </p>
        )}
        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}
        <div className="adm-form-actions">
          {credentials ? (
            <>
              <Button
                size="cta"
                type="button"
                variant="outline"
                onClick={() => void handleReissue()}
                disabled={busy !== null}
                loading={busy === "reissue"}
              >
                {busy === "reissue" ? t("computer.token_reissuing") : t("computer.token_reissue_action")}
              </Button>
              <Button size="cta" type="button" onClick={onClose}>
                {t("admin.v2.close_drawer")}
              </Button>
            </>
          ) : (
            <>
              {!unrecoverable ? (
                <Button
                  size="cta"
                  type="button"
                  onClick={() => void handleReveal()}
                  disabled={busy !== null}
                  loading={busy === "reveal"}
                >
                  {busy === "reveal" ? t("computer.token_revealing") : t("computer.token_reveal_action")}
                </Button>
              ) : null}
              <Button
                size="cta"
                type="button"
                variant="outline"
                onClick={() => void handleReissue()}
                disabled={busy !== null}
                loading={busy === "reissue"}
              >
                {busy === "reissue" ? t("computer.token_reissuing") : t("computer.token_reissue_action")}
              </Button>
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}
