import type { TFunction } from "i18next";
import type { DaemonNodeMonitorRecord } from "../../types";

export function DaemonVersion({ node, t }: { node: DaemonNodeMonitorRecord; t: TFunction }) {
  return <span>{t("computer.daemon_version", { version: node.clientVersion || t("computer.fact_unset") })}</span>;
}
