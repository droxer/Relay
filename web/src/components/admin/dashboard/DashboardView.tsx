"use client";

import { useState } from "react";
import { DashboardRangePicker } from "./DashboardRangePicker";
import { dashboardPresetRange, type DashboardRangeSelection, type DashboardDateRange } from "../../../lib/dashboardRange";
import { useQuery } from "@tanstack/react-query";
import { getDashboardAgents } from "../../../api";
import { ADMIN_ROSTER_POLL_MS } from "../../../lib/controlPanelQueries";
import { useTranslation } from "react-i18next";
import { useDashboardSessions } from "../../../hooks/useDashboardSessions";
import { useDashboardWork } from "../../../hooks/useDashboardWork";
import { useTokenUsage } from "../../../hooks/useTokenUsage";
import type { NodeMetrics } from "../../../hooks/useNodeMetrics";
import type { ControlPanelDaemonNodeRecord } from "../../../types";
import { RuntimeUsage, RuntimeInventory } from "./RuntimeStats";
import { WorkStatsRow } from "./WorkStats";
import { ActivityChart } from "./ActivityChart";
import { NodeStatusCard } from "./NodeStatusCard";
import { KpiTile } from "./KpiTile";
import { TokenUsageChart } from "./TokenUsageChart";
import { TopUsers } from "./TopUsers";
import { formatCompact } from "../../../lib/compactNumber";
import { activityTotals, successRate } from "../../../lib/activityChart";
import { fleetSummary } from "../../../lib/fleetSlots";

interface DashboardViewProps {
  nodes: ControlPanelDaemonNodeRecord[];
  metrics: NodeMetrics;
  onManageNodes: () => void;
  inventoryLoading?: boolean;
  inventoryError?: string | null;
}

export function DashboardView({
  nodes, metrics, onManageNodes, inventoryLoading, inventoryError,
}: DashboardViewProps) {
  const { t, i18n } = useTranslation();
  const [preset, setPreset] = useState<DashboardRangeSelection>("7d");
  const [customRange, setCustomRange] = useState<DashboardDateRange>(() => dashboardPresetRange("7d"));
  const range = preset === "custom" ? customRange : preset === "all" ? "all" : dashboardPresetRange(preset);
  const sessionsQuery = useDashboardSessions(true, range);
  const workQuery = useDashboardWork(true, range);
  const tokens = useTokenUsage(range);
  const agentsQuery = useQuery({
    queryKey: ["admin", "dashboard", "agents"],
    queryFn: ({ signal }) => getDashboardAgents(signal),
    staleTime: ADMIN_ROSTER_POLL_MS,
    refetchInterval: ADMIN_ROSTER_POLL_MS,
    select: (data) => data.count,
  });

  const sessionsReady = !sessionsQuery.isLoading && !sessionsQuery.error;
  const sessions = sessionsQuery.data;
  const workReady = !workQuery.isLoading && !workQuery.error;
  const work = workQuery.data;
  const nodesReady = nodes.length > 0 || (inventoryLoading === false && !inventoryError);

  const dash = "—";
  const showTokens = tokens.available || tokens.isError || tokens.isLoading || (tokens.daily?.length ?? 0) > 0;

  const rate = successRate(sessions.dailyCounts);
  const outcomes = activityTotals(sessions.dailyCounts);
  const fleet = fleetSummary(nodes);
  const fleetCount = (key: string) => fleet.slots.find((slot) => slot.key === key)?.count ?? 0;
  const percent = new Intl.NumberFormat(i18n.language || undefined, { style: "percent", maximumFractionDigits: 1 });

  return (
    <div className="adm-dash">
      <DashboardRangePicker preset={preset} range={range}
        onPreset={(next) => {
          if (next === "custom") setCustomRange(range === "all" ? dashboardPresetRange("7d") : range);
          setPreset(next);
        }}
        onApply={setCustomRange} />
      <div className="adm-dash-kpis-wrap">
        <section
          className="adm-dash-kpis adm-dash-kpis--grid"
          aria-label={t("admin.v2.dash_kpis_label")}
        >
          <KpiTile
            slot="sessions"
            eyebrow={t("admin.v2.dash_kpi_sessions")}
            value={sessionsReady ? formatCompact(sessions.total, i18n.language) : dash}
          />
          <KpiTile
            slot="conversations"
            eyebrow={t("admin.v2.dash_kpi_conversations")}
            value={workReady ? formatCompact(work.conversations.chats, i18n.language) : dash}
            hint={
              workQuery.isError
                ? t("workspace.load_failed")
                : workReady
                ? t("admin.v2.dash_kpi_conversations_hint", {
                    project: formatCompact(work.conversations.projectChats, i18n.language),
                    standalone: formatCompact(work.conversations.standaloneChats, i18n.language),
                  })
                : undefined
            }
          />
          <KpiTile
            slot="tasks"
            eyebrow={t("admin.v2.dash_kpi_tasks")}
            value={workReady ? formatCompact(work.tasks.created, i18n.language) : dash}
            hint={
              workQuery.isError
                ? t("workspace.load_failed")
                : workReady
                ? t("admin.v2.dash_kpi_tasks_hint", {
                    done: formatCompact(work.tasks.done, i18n.language),
                    inProgress: formatCompact(work.tasks.inProgress, i18n.language),
                  })
                : undefined
            }
          />
          {showTokens ? (
            <KpiTile
              slot="tokens"
              eyebrow={t("admin.v2.dash_kpi_tokens")}
              value={tokens.isError || tokens.isLoading ? dash : formatCompact(tokens.fresh, i18n.language)}
              hint={tokens.isError ? t("workspace.load_failed") : t("admin.v2.dash_kpi_tokens_hint")}
            />
          ) : null}
          {/* Completed share of the threads that finished in the chart's
              window. No reading until something finishes: 0% would claim
              that everything failed. */}
          <KpiTile
            slot="success"
            eyebrow={t("admin.v2.dash_kpi_success")}
            value={sessionsReady && rate !== null ? percent.format(rate) : dash}
            hint={
              sessionsReady && rate !== null
                ? t("admin.v2.dash_kpi_success_hint", {
                    failed: outcomes.failed,
                    finished: outcomes.completed + outcomes.failed,
                  })
                : undefined
            }
          />
          <KpiTile
            slot="projects"
            eyebrow={t("admin.v2.dash_kpi_projects")}
            value={workReady ? formatCompact(work.projects.total, i18n.language) : dash}
            hint={
              workQuery.isError
                ? t("workspace.load_failed")
                : workReady
                ? t("admin.v2.dash_kpi_projects_hint", {
                    active: formatCompact(work.projects.activeInRange, i18n.language),
                    created: formatCompact(work.projects.created, i18n.language),
                  })
                : t("admin.v2.dash_current_inventory")
            }
          />
          {/* Live fleet count; the full status breakdown sits in NodeStatusCard below. */}
          <KpiTile
            slot="nodes"
            eyebrow={t("admin.v2.dash_kpi_nodes")}
            value={nodesReady ? formatCompact(metrics.total, i18n.language) : dash}
            hint={
              fleet.total > 0
                ? t("admin.v2.dash_kpi_nodes_hint", { running: fleetCount("running"), ready: fleetCount("ready") })
                : undefined
            }
          />
          <KpiTile
            slot="agents"
            eyebrow={t("admin.v2.dash_kpi_agents")}
            value={agentsQuery.isSuccess ? formatCompact(agentsQuery.data, i18n.language) : dash}
            hint={agentsQuery.isError ? t("workspace.load_failed") : t("admin.v2.dash_current_inventory")}
          />
        </section>
      </div>

      {/* Related panels share a row. DOM order keeps fleet health directly
          after activity when the available canvas becomes a single column. */}
      <div className="adm-dash-grid">
        <ActivityChart
          daily={sessions.dailyCounts}
          bucketSize={sessions.bucketSize}
          ready={sessionsReady}
          error={sessionsQuery.error}
        />
        <NodeStatusCard
          nodes={nodes}
          queued={metrics.queued}
          onManageNodes={onManageNodes}
          className="adm-dash-health"
        />
        <WorkStatsRow
          data={work}
          loading={workQuery.isLoading}
          error={workQuery.error}
        />
        {showTokens ? (
          <TokenUsageChart snapshot={tokens} />
        ) : null}
        <TopUsers
          className={`adm-dash-panel${showTokens ? "" : " adm-dash-panel--wide"}`}
          ranked={sessions.topUsers}
          error={sessionsQuery.error}
        />
        <RuntimeUsage snapshot={tokens} />
        <RuntimeInventory nodes={nodes} loading={inventoryLoading} error={inventoryError} />
      </div>
    </div>
  );
}
