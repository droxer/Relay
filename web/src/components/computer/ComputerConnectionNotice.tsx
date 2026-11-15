"use client";

import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import type { ComputerConnection } from "../../lib/computerConnection";
import { ICON, StatusError, StatusInfo, StatusWarn } from "../icons";

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
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  connection: ComputerConnection;
  t: TFunction;
}) {
  const { title, body } = noticeKey(connection, Boolean(node.managedNodeId));
  const Icon = connection.tone === "bad" ? StatusError : connection.tone === "warn" ? StatusWarn : StatusInfo;
  return (
    <div className="computer-card-connection" data-tone={connection.tone} role="status">
      <Icon size={ICON.sm} aria-hidden="true" />
      <div className="computer-card-connection-copy">
        <p className="computer-card-connection-title">{t(title)}</p>
        <p className="computer-card-connection-body">
          <Trans i18nKey={body} t={t} components={{ cmd: <code className="code" /> }} />
          {connection.pendingReports > 0 ? (
            <>
              {" "}
              <span className="computer-card-connection-count tnum">
                {t("computer.connection_pending_reports", { count: connection.pendingReports })}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
