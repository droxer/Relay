"use client";

import { useTranslation } from "react-i18next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TokenUsageState } from "../../../hooks/useTokenUsage";
import type { ControlPanelDaemonNodeRecord } from "../../../types";
import { isVisibleAgentRuntime } from "../../../lib/agentRuntimeOrder";
import { runtimeInventory } from "../../../lib/runtimeInventory";
import { formatCompact } from "../../../lib/compactNumber";
import { runtimeLabel } from "../../../lib/runtimeLabel";

function runtimeName(agent: string | null, unknown: string) {
  if (!agent) return unknown;
  return runtimeLabel(agent);
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
        : <Table className="adm-runtime-stats">
          <TableCaption className="sr-only">{t("admin.v2.dash_runtime_usage")}</TableCaption>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">{t("admin.v2.dash_runtime_name")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_runs")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_fresh")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_cache")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{rows.map(row => <TableRow key={row.agent ?? "unknown"} className="hover:bg-transparent">
            <th scope="row"><span translate={row.agent ? "no" : undefined}>{runtimeName(row.agent, t("admin.v2.dash_runtime_unknown"))}</span>
              {row.reportedRuns < row.runs ? <span className="adm-runtime-note">{t("admin.v2.dash_runtime_coverage", { reported: row.reportedRuns, count: row.runs })}</span> : null}
            </th>
            <TableCell title={row.runs.toLocaleString(i18n.language)}>{format(row.runs)}</TableCell>
            <TableCell title={row.reportedRuns ? row.fresh.toLocaleString(i18n.language) : undefined}>{row.reportedRuns ? format(row.fresh) : "—"}</TableCell>
            <TableCell title={row.reportedRuns ? row.cacheRead.toLocaleString(i18n.language) : undefined}>{row.reportedRuns ? format(row.cacheRead) : "—"}</TableCell>
          </TableRow>)}</TableBody>
        </Table>}
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
        : <Table className="adm-runtime-stats adm-runtime-stats--inventory">
          <TableCaption className="sr-only">{t("admin.v2.dash_runtime_inventory")}</TableCaption>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead scope="col">{t("admin.v2.dash_runtime_name")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_installed")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_ready")}</TableHead>
            <TableHead scope="col">{t("admin.v2.dash_runtime_failed")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{runtimeInventory(nodes).map(row => <TableRow key={row.agent} className="hover:bg-transparent">
            <th scope="row" translate="no">{runtimeName(row.agent, "")}</th>
            <TableCell>{row.installed.toLocaleString(i18n.language)}</TableCell>
            <TableCell>{row.ready.toLocaleString(i18n.language)}</TableCell>
            <TableCell className={row.failed ? "adm-runtime-fault" : undefined}>{row.failed.toLocaleString(i18n.language)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>}
      <CardDescription>{t("admin.v2.dash_runtime_inventory_note")}</CardDescription>
    </Card>
  );
}
