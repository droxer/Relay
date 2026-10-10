"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ComputerPlatformSupport } from "./ComputerPlatformSupport";
import { reissueComputerToken } from "../../api";
import type { ComputerTokenResponse, ControlPanelDaemonNodeRecord } from "../../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { CredCopyRow } from "../admin/CredCopyRow";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { Alert } from "@/components/ui/alert";
import { useOnOpen } from "@/hooks/useKeyChange";

interface ComputerTokenDrawerProps {
  open: boolean;
  onClose: () => void;
  node: ControlPanelDaemonNodeRecord | null;
}

/** Reissue a computer credential and display it once. */
export function ComputerTokenDrawer({ open, onClose, node }: ComputerTokenDrawerProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { copiedField, copy } = useCopyFeedback();
  const [credentials, setCredentials] = useState<ComputerTokenResponse | null>(null);
  const [reissued, setReissued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reissue" | null>(null);
  const credentialsRef = useRef<HTMLDivElement>(null);

  useOnOpen(open, () => {
    setCredentials(null);
    setReissued(false);
    setError(null);
    setBusy(null);
  });

  // Move focus to the newly issued credentials.
  useEffect(() => {
    if (credentials) credentialsRef.current?.focus();
  }, [credentials]);

  if (!node) return null;

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
              <>
                <ComputerPlatformSupport />
                <CredCopyRow
                  label={t(credentials.installCommand ? "computer.connect_setup_label" : "admin.daemon_command")}
                  hint={t(credentials.installCommand ? "computer.connect_setup_hint" : "admin.daemon_command_hint")}
                  value={credentials.installCommand ?? credentials.daemonCommand!}
                  copyLabel={t(credentials.installCommand ? "computer.connect_setup_copy" : "admin.copy_daemon_command")}
                  copied={copiedField === "command"}
                  onCopy={() => void copy("command", credentials.installCommand ?? credentials.daemonCommand!)}
                />
              </>
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
            {t("computer.token_unrecoverable")}
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
