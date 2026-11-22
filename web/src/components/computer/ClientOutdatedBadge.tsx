"use client";

import type { TFunction } from "i18next";
import type { DaemonNodeMonitorRecord } from "../../types";
import { TonePill } from "../StatusPill";

type ClientUpdateStatus = Pick<DaemonNodeMonitorRecord, "clientOutdated" | "clientUpdateAvailable">;

export function hasClientUpdate(node: ClientUpdateStatus): boolean {
  return node.clientOutdated === true || node.clientUpdateAvailable === true;
}

export function ClientOutdatedBadge({ node, t }: { node: ClientUpdateStatus; t: TFunction }) {
  if (!hasClientUpdate(node)) return null;
  return (
    <TonePill
      tone="warn"
      label={t("computer.client_outdated")}
      title={t("computer.client_outdated_hint")}
      className="computer-outdated-badge"
    />
  );
}
