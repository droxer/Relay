"use client";

import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import type { ComputerConnection } from "../../lib/computerConnection";
import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { ActionCopy, ICON, StatusError, StatusInfo, StatusOk, StatusWarn } from "../icons";

/** Inline CLI command with a quiet one-click copy action. */
export function InlineCopyCommand({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { copiedField, copy } = useCopyFeedback();
  const command = typeof children === "string" ? children.trim() : "";
  if (!command) return <code className="code">{children}</code>;
  const copied = copiedField === command;
  return (
    <span className="computer-inline-cmd">
      <code className="code">{children}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-dense"
        className="computer-inline-cmd-copy"
        onClick={() => void copy(command, command)}
        aria-label={t(copied ? "computer.command_copied" : "computer.copy_command", { command })}
        title={t(copied ? "computer.command_copied" : "computer.copy_command", { command })}
      >
        {copied ? <StatusOk size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
      </Button>
    </span>
  );
}

/** Which copy a reading speaks with: its state, or the issue behind it. */
function noticeKey(connection: ComputerConnection, managed: boolean): { title: string; body: string } {
  const name = connection.state === "unsettled" || connection.state === "attention"
    ? connection.issue ?? "communication"
    : connection.state;
  return {
    title: `computer.connection_${name}_title`,
    body: name === "offline" && managed ? "computer.connection_offline_managed_body" : `computer.connection_${name}_body`,
  };
}

/**
 * Why this computer is not simply "Online", and what its owner can do about
 * it. The presence pill says connected or not; this says the rest — it is
 * reconnecting on its own, it was stopped, its credential was refused, its
 * reports are stuck — with the command to run where there is one.
 *
 * Absence is not failure (lib/statusTone.ts): an offline or stopped computer
 * speaks in the neutral voice. Only a refused credential is an error.
 */
export function ComputerConnectionNotice({
  node,
  connection,
  onShowToken,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  connection: ComputerConnection;
  onShowToken?: (node: ControlPanelDaemonNodeRecord) => void;
  t: TFunction;
}) {
  const { title, body } = noticeKey(connection, Boolean(node.managedNodeId));
  const webCleanup = node.capabilities?.includes("report-cleanup");
  const Icon = connection.tone === "bad" ? StatusError : connection.tone === "warn" ? StatusWarn : StatusInfo;
  // Offline and revoked states are already named in the card header's presence
  // readout, so repeating the title here adds clutter without new information.
  const showTitle = connection.state !== "offline" && connection.state !== "revoked";
  const showReissueAction = connection.state === "revoked" && Boolean(onShowToken);
  return (
    <div className="computer-card-connection" data-tone={connection.tone} role="status">
      <Icon size={ICON.sm} aria-hidden="true" />
      <div className="computer-card-connection-copy">
        {showTitle ? <p className="computer-card-connection-title">{t(title)}</p> : null}
        <p className="computer-card-connection-body">
          <Trans i18nKey={webCleanup && connection.issue === "quarantine" ? "computer.connection_quarantine_web_body" : body}
            t={t} components={{ cmd: <InlineCopyCommand /> }} />
          {!webCleanup && connection.pendingReports > 0 ? (
            <>
              {" "}
              <span className="computer-card-connection-count tnum">
                {t("computer.connection_pending_reports", { count: connection.pendingReports })}
              </span>
            </>
          ) : null}
        </p>
        {showReissueAction ? (
          <div className="computer-card-connection-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => onShowToken?.(node)}>
              {t("computer.token_reissue_action")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
