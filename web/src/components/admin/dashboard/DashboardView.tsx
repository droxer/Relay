"use client";

import { useState } from "react";
import { DashboardRangePicker } from "./DashboardRangePicker";
import { dashboardPresetRange, type DashboardRangeSelection, type DashboardDateRange } from "../../../lib/dashboardRange";
import { useQuery } from "@tanstack/react-query";
import { listControlPanelAgents } from "../../../api";
import { ADMIN_ROSTER_POLL_MS } from "../../../lib/controlPanelQueries";
import { useTranslation } from "react-i18next";
import { useDashboardSessions } from "../../../hooks/useDashboardSessions";
import { useTokenUsage } from "../../../hooks/useTokenUsage";
import type { NodeMetrics } from "../../../hooks/useNodeMetrics";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../../types";
import { ActivityChart } from "./ActivityChart";
import { NodeStatusCard } from "./NodeStatusCard";
import { KpiTile } from "./KpiTile";
import { TokenUsageChart } from "./TokenUsageChart";
import { TopUsers } from "./TopUsers";
import { Sparkline } from "./Sparkline";
import { formatCompact } from "../../../lib/compactNumber";
import { activityTotals, successRate } from "../../../lib/activityChart";
import { displayTone, fleetSummary } from "../../../lib/fleetSlots";

interface DashboardViewProps {
  nodes: ControlPanelDaemonNodeRecord[];
  users: UserRecord[];
  metrics: NodeMetrics;
  onManageNodes: () => void;
}

export function DashboardView({
  nodes, users, metrics, onManageNodes,
}: DashboardViewProps) {
  const { t, i18n } = useTranslation();
  const [preset, setPreset] = useState<DashboardRangeSelection>("7d");
  const [customRange, setCustomRange] = useState<DashboardDateRange>(() => dashboardPresetRange("7d"));
  const range = preset === "custom" ? customRange : preset === "all" ? "all" : dashboardPresetRange(preset);
  const sessionsQuery = useDashboardSessions(true, range);
  const tokens = useTokenUsage(range);
  const agentsQuery = useQuery({
    queryKey: ["admin", "agents"],
    queryFn: ({ signal }) => listControlPanelAgents(undefined, signal),
    refetchInterval: ADMIN_ROSTER_POLL_MS,
    select: (data) => data.agents.filter((agent) => !agent.deletedAt).length,
  });

  const sessionsReady = !sessionsQuery.isLoading && !sessionsQuery.error;
  const sessions = sessionsQuery.data;
  const nodesReady = nodes.length > 0 || users.length > 0;

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
          className={`adm-dash-kpis${showTokens ? "" : " adm-dash-kpis--lean"}`}
          aria-label={t("admin.v2.dash_kpis_label")}
        >
          <KpiTile
            slot="sessions"
            eyebrow={t("admin.v2.dash_kpi_sessions")}
            value={sessionsReady ? formatCompact(sessions.total, i18n.language) : dash}
            visual={sessionsReady ? <Sparkline points={sessions.dailyCounts.map((day) => day.count)} /> : null}
          />
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
          {/* The count, with the fleet's state mix as a meter. The full
              breakdown is the fleet card's job in the rail below. */}
          <KpiTile
            slot="nodes"
            eyebrow={t("admin.v2.dash_kpi_nodes")}
            value={nodesReady ? formatCompact(metrics.total, i18n.language) : dash}
            visual={
              fleet.total > 0 ? (
                <span className="adm-dash-bar adm-dash-tile-meter" aria-hidden="true">
                  {fleet.slots.filter((slot) => slot.count > 0).map((slot) => (
                    <span
                      key={slot.key}
                      className={`adm-dash-bar-seg tone-${displayTone(slot)}`}
                      style={{ flexBasis: `${slot.share * 100}%` }}
                    />
                  ))}
                </span>
              ) : null
            }
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
          {showTokens ? (
            <KpiTile
              slot="tokens"
              eyebrow={t("admin.v2.dash_kpi_tokens")}
              value={tokens.isError || tokens.isLoading ? dash : formatCompact(tokens.fresh, i18n.language)}
              visual={tokens.isError || tokens.isLoading ? null : <Sparkline points={tokens.daily.map((day) => day.fresh)} />}
              hint={tokens.isError ? t("workspace.load_failed") : t("admin.v2.dash_kpi_tokens_hint")}
            />
          ) : null}
        </section>
      </div>

      {/* 2:1 editorial split — time-series in the wide column, rosters in the
          rail. The two stacks are independent, so a short card cannot drag a
          hole through the row beside it the way the old three-across belt did. */}
      <div className="adm-dash-grid">
        <div className="adm-dash-col">
          <ActivityChart
            daily={sessions.dailyCounts}
            bucketSize={sessions.bucketSize}
            ready={sessionsReady}
            error={sessionsQuery.error}
          />
          {showTokens ? (
            <TokenUsageChart snapshot={tokens} />
          ) : null}
        </div>
        <div className="adm-dash-col">
          {/* Both rail panels take the fixed instrument frame: their contents
              arrive and re-rank live, and a panel that resized with them
              would move the other one under the reader's eye. */}
          <NodeStatusCard
            nodes={nodes}
            queued={metrics.queued}
            onManageNodes={onManageNodes}
            className="adm-dash-panel"
          />
          <TopUsers
            className="adm-dash-panel"
            users={users}
            ranked={sessions.topUsers}
            error={sessionsQuery.error}
          />
        </div>
      </div>
    </div>
  );
}
