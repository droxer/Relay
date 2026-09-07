"use client";

import { useTranslation } from "react-i18next";
import { useDashboardSessions } from "../../../hooks/useDashboardSessions";
import { useTokenUsage } from "../../../hooks/useTokenUsage";
import type { NodeMetrics } from "../../../hooks/useNodeMetrics";
import type { ControlPanelDaemonNodeRecord, EmployeeRecord } from "../../../types";
import { ActivityChart } from "./ActivityChart";
import { NodeStatusCard } from "./NodeStatusCard";
import { KpiTile } from "./KpiTile";
import { TokenUsageChart } from "./TokenUsageChart";
import { Button } from "@/components/ui/button";
import { ActionAdd, AdminNode, ICON } from "../../icons";
import { StateMark } from "../../StateMark";
import { TopEmployees } from "./TopEmployees";

interface DashboardViewProps {
  nodes: ControlPanelDaemonNodeRecord[];
  employees: EmployeeRecord[];
  metrics: NodeMetrics;
  onManageNodes: () => void;
  onAddNode: () => void;
  onAddEmployee: () => void;
}

export function DashboardView({
  nodes, employees, metrics, onManageNodes, onAddNode, onAddEmployee,
}: DashboardViewProps) {
  const { t, i18n } = useTranslation();
  const sessionsQuery = useDashboardSessions(true);
  const tokens = useTokenUsage();

  const sessionsReady = !sessionsQuery.isLoading && !sessionsQuery.error;
  const sessions = sessionsQuery.data;
  const nodesReady = nodes.length > 0 || employees.length > 0;

  const dash = "—";
  const showTokens = tokens.available || tokens.isError;

  const last24h = sessions.last24h;
  const prior24h = clampNonNeg(sessions.last7d - last24h) / 6;
  const trend = compareTrend(last24h, prior24h);

  return (
    <div className="adm-dash">
      <section className="adm-control-intro" aria-labelledby="adm-overview-title">
        <div className="adm-control-intro-copy">
          <span className="adm-control-eyebrow">{t("admin.control_panel.overview")}</span>
          <h2 id="adm-overview-title">{t("admin.control_panel.heading")}</h2>
          <p>{t("admin.control_panel.description")}</p>
        </div>
        <div className="adm-control-actions">
          <Button onClick={onAddNode}>
            <ActionAdd size={ICON.sm} aria-hidden="true" />
            {t("admin.v2.add_node_cta")}
          </Button>
          <Button variant="outline" onClick={onAddEmployee}>
            {t("admin.v2.add_employee_cta")}
          </Button>
        </div>
      </section>
      <section className="adm-control-fleet" aria-label={t("admin.control_panel.fleet")}>
        <div className="adm-control-fleet-label">
          <AdminNode size={ICON.md} aria-hidden="true" />
          <span>{t("admin.control_panel.fleet")}</span>
        </div>
        <dl className="adm-control-readings">
          {([
            ["ready", metrics.ready, "good"],
            ["running", metrics.running, "live"],
            ["attention", metrics.failed, "bad"],
            ["queued", metrics.queued, "neutral"],
          ] as const).map(([label, count, tone]) => (
            <div key={label}>
              <dt>
                <StateMark tone={count > 0 ? tone : "neutral"} />
                {t(`admin.control_panel.${label}`)}
              </dt>
              <dd>{nodesReady ? new Intl.NumberFormat(i18n.language).format(count) : dash}</dd>
            </div>
          ))}
        </dl>
        <Button variant="ghost" onClick={onManageNodes}>
          {t("admin.control_panel.manage_fleet")}
          <span aria-hidden="true">↗</span>
        </Button>
      </section>
      <div className="adm-dash-kpis-wrap">
        <section
          className={`adm-dash-kpis${showTokens ? "" : " adm-dash-kpis--lean"}`}
          aria-label={t("admin.v2.dash_kpis_label")}
        >
          <KpiTile
            slot="sessions"
            hero
            eyebrow={t("admin.v2.dash_kpi_sessions")}
            value={sessionsReady ? formatCompact(sessions.total, i18n.language) : dash}
            delta={
              sessionsReady
                ? {
                    direction: trend.direction,
                    label: t("admin.v2.dash_kpi_sessions_delta", {
                      count: last24h,
                      diff: trend.label,
                    }),
                  }
                : undefined
            }
          />
          <KpiTile
            slot="nodes"
            eyebrow={t("admin.v2.dash_kpi_nodes")}
            value={nodesReady ? formatCompact(metrics.total, i18n.language) : dash}
            hint={
              nodesReady
                ? t("admin.v2.dash_kpi_nodes_hint", { ready: metrics.ready, failed: metrics.failed })
                : undefined
            }
          />
          <KpiTile
            slot="employees"
            eyebrow={t("admin.v2.dash_kpi_employees")}
            value={nodesReady ? formatCompact(metrics.employeeTotal, i18n.language) : dash}
            hint={nodesReady ? t("admin.v2.dash_kpi_employees_hint", { count: employees.length }) : undefined}
          />
          {showTokens ? (
            <KpiTile
              slot="tokens"
              eyebrow={t("admin.v2.dash_kpi_tokens")}
              value={tokens.isError ? dash : formatCompact(tokens.total, i18n.language)}
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
            ready={sessionsReady}
            error={sessionsQuery.error}
          />
          {showTokens ? (
            <TokenUsageChart snapshot={tokens} compact />
          ) : null}
        </div>
        <div className="adm-dash-col">
          <NodeStatusCard nodes={nodes} />
          <TopEmployees
            employees={employees}
            nodes={nodes}
            ranked={sessions.topEmployees}
            error={sessionsQuery.error}
          />
        </div>
      </div>
    </div>
  );
}

function clampNonNeg(value: number): number {
  return value < 0 ? 0 : value;
}

interface Trend {
  direction: "up" | "down" | "flat";
  label: string;
}

function compareTrend(current: number, prior: number): Trend {
  if (prior <= 0 && current <= 0) return { direction: "flat", label: "0" };
  if (prior <= 0) return { direction: "up", label: `+${current}` };
  const diff = current - prior;
  if (Math.abs(diff) < 0.5) return { direction: "flat", label: "±0" };
  const pct = Math.round((diff / prior) * 100);
  return {
    direction: diff > 0 ? "up" : "down",
    label: `${pct > 0 ? "+" : ""}${pct}%`,
  };
}

// Compact notation earns its keep on token counts (2.7M) but throws away
// precision on the numbers an operator actually reads back — 1,041 threads
// became "1K". Group below 100k, compact above.
const COMPACT_THRESHOLD = 100_000;

function formatCompact(value: number, locale: string): string {
  return value < COMPACT_THRESHOLD
    ? new Intl.NumberFormat(locale).format(value)
    : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
