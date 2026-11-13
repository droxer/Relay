"use client";

import { useTranslation } from "react-i18next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TokenUsageState } from "../../../hooks/useTokenUsage";
import type { ControlPanelDaemonNodeRecord } from "../../../types";
import { isVisibleAgentRuntime } from "../../../lib/agentRuntimeOrder";
import { runtimeInventory } from "../../../lib/runtimeInventory";
import { formatCompact } from "../../../lib/compactNumber";

function runtimeName(agent: string | null, unknown: string) {
  if (!agent) return unknown;
  if (agent === "opencode") return "OpenCode";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

export function RuntimeUsage({ snapshot }: { snapshot: TokenUsageState }) {
  const { t, i18n } = useTranslation();
  const rows = (snapshot.runtimes ?? []).filter((row) => row.agent === null || isVisibleAgentRuntime(row.agent));
  const format = (value: number) => formatCompact(value, i18n.language);
  return (
    <Card render={<section />}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_runtime_usage")}</CardTitle>
        <CardDescription>{t("admin.v2.dash_runtime_usage_hint")}</CardDescription>
      </CardHeader>
      {snapshot.isError ? <CardDescription role="alert">{t("workspace.load_failed")}</CardDescription>
        : snapshot.isLoading ? <CardDescription role="status">{t("admin.v2.dash_loading")}</CardDescription>
        : rows.length === 0 ? <CardDescription>{t("admin.v2.dash_runtime_empty")}</CardDescription>
        : <table className="adm-runtime-stats">
          <caption className="sr-only">{t("admin.v2.dash_runtime_usage")}</caption>
          <thead><tr>
            <th scope="col">{t("admin.v2.dash_runtime_name")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_runs")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_fresh")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_cache")}</th>
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.agent ?? "unknown"}>
            <th scope="row"><span translate={row.agent ? "no" : undefined}>{runtimeName(row.agent, t("admin.v2.dash_runtime_unknown"))}</span>
              {row.reportedRuns < row.runs ? <span className="adm-runtime-note">{t("admin.v2.dash_runtime_coverage", { reported: row.reportedRuns, count: row.runs })}</span> : null}
            </th>
            <td title={row.runs.toLocaleString(i18n.language)}>{format(row.runs)}</td>
            <td title={row.reportedRuns ? row.fresh.toLocaleString(i18n.language) : undefined}>{row.reportedRuns ? format(row.fresh) : "—"}</td>
            <td title={row.reportedRuns ? row.cacheRead.toLocaleString(i18n.language) : undefined}>{row.reportedRuns ? format(row.cacheRead) : "—"}</td>
          </tr>)}</tbody>
        </table>}
    </Card>
  );
}

export function RuntimeInventory({ nodes, loading, error }: {
  nodes: ControlPanelDaemonNodeRecord[]; loading?: boolean; error?: string | null;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card render={<section />}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_runtime_inventory")}</CardTitle>
        <CardDescription>{t("admin.v2.dash_runtime_inventory_hint")}</CardDescription>
      </CardHeader>
      {error ? <CardDescription role="alert">{t("workspace.load_failed")}</CardDescription>
        : loading ? <CardDescription role="status">{t("admin.v2.dash_loading")}</CardDescription>
        : <table className="adm-runtime-stats adm-runtime-stats--inventory">
          <caption className="sr-only">{t("admin.v2.dash_runtime_inventory")}</caption>
          <thead><tr>
            <th scope="col">{t("admin.v2.dash_runtime_name")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_installed")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_ready")}</th>
            <th scope="col">{t("admin.v2.dash_runtime_failed")}</th>
          </tr></thead>
          <tbody>{runtimeInventory(nodes).map(row => <tr key={row.agent}>
            <th scope="row" translate="no">{runtimeName(row.agent, "")}</th>
            <td>{row.installed.toLocaleString(i18n.language)}</td>
            <td>{row.ready.toLocaleString(i18n.language)}</td>
            <td className={row.failed ? "adm-runtime-fault" : undefined}>{row.failed.toLocaleString(i18n.language)}</td>
          </tr>)}</tbody>
        </table>}
      <CardDescription>{t("admin.v2.dash_runtime_inventory_note")}</CardDescription>
    </Card>
  );
}
