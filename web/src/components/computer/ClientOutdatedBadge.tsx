"use client";

import type { TFunction } from "i18next";
import type { DaemonNodeMonitorRecord } from "../../types";
import { TonePill } from "../StatusPill";

/** "Update available" on a computer whose Relay client is older than the
    server expects. The backend decides (`clientOutdated`); an older backend
    sends nothing and the badge stays away. The pill's title says what to do,
    and surfaces with room for a sentence say it in the open too. */
export function ClientOutdatedBadge({ node, t }: { node: Pick<DaemonNodeMonitorRecord, "clientOutdated">; t: TFunction }) {
  if (node.clientOutdated !== true) return null;
  return (
    <TonePill
      tone="warn"
      label={t("computer.client_outdated")}
      title={t("computer.client_outdated_hint")}
      className="computer-outdated-badge"
    />
  );
}
