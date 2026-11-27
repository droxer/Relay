"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { groupAgentsByComputer } from "../../lib/agentGroups";
import { activePlacements, describeAgentPlacements } from "../../lib/agentPlacements";
import { agentModel } from "../../lib/agentModels";
import { describeAgentRosterStatus } from "../../lib/agentStatus";
import { agentLabel } from "../../lib/plan";
import type { UserAgent } from "../../types";
import { AgentStateBadge } from "../AgentStateBadge";
import { PageHeader } from "../PageHeader";
import { AgentRoleMeta } from "../RoleLevelBadge";
import { StatusPill, TonePill } from "../StatusPill";
import { ActionAdd, ICON } from "../icons";

interface AgentsOverviewProps {
  agents: readonly UserAgent[];
  canCreate: boolean;
  onOpenAgent: (agent: UserAgent) => void;
  onCreateAgent: () => void;
}

export interface AgentFleetSummary {
  total: number;
  ready: number;
  busy: number;
  pending: number;
  offline: number;
  computers: number;
}

export function summarizeAgentFleet(agents: readonly UserAgent[]): AgentFleetSummary {
  let ready = 0;
  let busy = 0;
  let pending = 0;
  let offline = 0;
  const computerKeys = new Set<string>();

  for (const agent of agents) {
    if (!agent.enabled || agent.availability === "offline") {
      offline += 1;
    } else if (agent.availability === "busy") {
      busy += 1;
    } else if (agent.availability === "pending") {
      pending += 1;
    } else {
      ready += 1;
    }
    for (const placement of activePlacements(agent.placements)) {
      const key = placement.computerId || placement.runtimeNodeId || placement.daemonNodeId;
      if (key) computerKeys.add(key);
    }
  }

  return {
    total: agents.length,
    ready,
    busy,
    pending,
    offline,
    computers: computerKeys.size,
  };
}

function AgentStatusCell({ agent }: { agent: UserAgent }) {
  const { t } = useTranslation();
  const rosterStatus = describeAgentRosterStatus(agent);
  if (!rosterStatus || rosterStatus.key.startsWith("status.")) {
    return <StatusPill value={agent.availability} />;
  }
  return (
    <TonePill
      tone={rosterStatus.tone === "live" ? "info" : rosterStatus.tone}
      label={t(rosterStatus.key)}
    />
  );
}

/**
 * Framed-sheet fleet overview shown on desktop when no single agent is open.
 * Answers the route's main question — which agents are ready across which
 * computers — with a divided metric strip and a scannable table.
 */
export function AgentsOverview({
  agents,
  canCreate,
  onOpenAgent,
  onCreateAgent,
}: AgentsOverviewProps) {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeAgentFleet(agents), [agents]);
  const computerGroups = useMemo(() => groupAgentsByComputer(agents), [agents]);

  const subtitleParts = [
    `${summary.ready} ${t("agents_page.metric_ready").toLowerCase()}`,
    summary.busy > 0 ? `${summary.busy} ${t("agents_page.metric_busy").toLowerCase()}` : null,
    summary.offline > 0 ? `${summary.offline} ${t("agents_page.metric_offline").toLowerCase()}` : null,
  ].filter(Boolean);

  return (
    <div className="workspace-page agents-overview">
      <PageHeader
        title={t("agents_page.title")}
        titleAs="h1"
        titleVariant="display"
        subtitle={subtitleParts.join(" · ")}
        actions={
          canCreate ? (
            <Button type="button" size="dense" onClick={onCreateAgent}>
              <ActionAdd size={ICON.sm} aria-hidden="true" />
              {t("agents_page.create_action")}
            </Button>
          ) : null
        }
      />

      <div className="agents-overview-body">
        <dl className="agents-overview-metrics" aria-label={t("agents_page.metrics")}>
          <div className="agents-overview-metric">
            <dt className="agents-overview-metric-label">{t("agents_page.metric_ready")}</dt>
            <dd className="agents-overview-metric-value tnum">{summary.ready}</dd>
          </div>
          <div className="agents-overview-metric">
            <dt className="agents-overview-metric-label">{t("agents_page.metric_busy")}</dt>
            <dd
              className="agents-overview-metric-value tnum"
              data-tone={summary.busy > 0 ? "live" : "muted"}
            >
              {summary.busy}
            </dd>
          </div>
          <div className="agents-overview-metric">
            <dt className="agents-overview-metric-label">{t("agents_page.metric_offline")}</dt>
            <dd
              className="agents-overview-metric-value tnum"
              data-tone={summary.offline > 0 ? "bad" : "muted"}
            >
              {summary.offline}
            </dd>
          </div>
          <div className="agents-overview-metric">
            <dt className="agents-overview-metric-label">{t("agents_page.computers")}</dt>
            <dd className="agents-overview-metric-value tnum">{summary.computers}</dd>
          </div>
        </dl>

        <div className="agents-overview-table-wrap">
          <table className="agents-overview-table">
            <thead>
              <tr>
                <th scope="col" className="agents-overview-col-agent">{t("agents_page.col_agent")}</th>
                <th scope="col">{t("agents_page.col_role")}</th>
                <th scope="col">{t("agents_page.runtime_host")}</th>
                <th scope="col">{t("agents_page.col_runtime")}</th>
                <th scope="col" className="agents-overview-col-status">{t("agents_page.col_status")}</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const placements = describeAgentPlacements(activePlacements(agent.placements));
                const primaryNode = placements[0]?.nodeName ?? null;
                const model = agentModel(agent);
                const rosterStatus = describeAgentRosterStatus(agent);
                return (
                  <tr
                    key={agent.id}
                    className="agents-overview-row"
                    data-unavailable={rosterStatus?.unavailable ? "true" : undefined}
                    onClick={() => onOpenAgent(agent)}
                  >
                    <td className="agents-overview-cell-agent">
                      <a
                        href={`/agents/${encodeURIComponent(agent.id)}`}
                        className="agents-overview-open"
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenAgent(agent);
                        }}
                      >
                        <AgentStateBadge
                          agent={agent.executorKind}
                          ready={agent.enabled && agent.availability === "ready"}
                          availability={agent.enabled ? agent.availability : undefined}
                          imageUrl={agent.profileImageUrl}
                          name={agent.displayName}
                        />
                        <span className="agents-overview-name">{agent.displayName}</span>
                      </a>
                    </td>
                    <td className="agents-overview-cell-role">
                      <AgentRoleMeta
                        identity={agent}
                        empty={<span className="agents-overview-dash" aria-label={t("admin.v2.agent_role_none")}>—</span>}
                      />
                    </td>
                    <td className="agents-overview-cell-host">
                      {primaryNode ? (
                        <span translate="no">{primaryNode}</span>
                      ) : (
                        <span className="agents-overview-dash">{t("agents_page.no_placements")}</span>
                      )}
                    </td>
                    <td className="agents-overview-cell-runtime">
                      <span className="agents-overview-runtime-name" translate="no">
                        {agentLabel(agent.executorKind)}
                      </span>
                      {model ? (
                        <span className="agents-overview-model code" translate="no">{model}</span>
                      ) : (
                        <span className="agents-overview-model-default">{t("agents_page.model_default")}</span>
                      )}
                    </td>
                    <td className="agents-overview-cell-status">
                      <AgentStatusCell agent={agent} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <section className="agents-overview-computers" aria-label={t("agents_page.computers")}>
          <h2 className="agents-overview-section-title">{t("agents_page.computers")}</h2>
          <div className="agents-overview-computer-list">
            {computerGroups.map((group) => {
              const groupSummary = summarizeAgentFleet(group.agents);
              const runtimes = [...new Set(group.agents.map((item) => agentLabel(item.executorKind)))];
              const label = group.label ?? t("agents_page.group_unplaced");
              return (
                <div key={group.key} className="agents-overview-computer-row">
                  <div className="agents-overview-computer-main">
                    <span className="agents-overview-computer-name" translate={group.label ? "no" : undefined}>
                      {label}
                    </span>
                    <span className="agents-overview-computer-runtimes" translate="no">
                      {runtimes.join(" · ")}
                    </span>
                  </div>
                  <div className="agents-overview-computer-stats">
                    <span className="agents-overview-computer-stat">
                      <span className="tnum">{groupSummary.ready}</span> {t("agents_page.metric_ready").toLowerCase()}
                    </span>
                    {groupSummary.busy > 0 ? (
                      <span className="agents-overview-computer-stat" data-tone="live">
                        <span className="tnum">{groupSummary.busy}</span> {t("agents_page.metric_busy").toLowerCase()}
                      </span>
                    ) : null}
                    {groupSummary.offline > 0 ? (
                      <span className="agents-overview-computer-stat" data-tone="bad">
                        <span className="tnum">{groupSummary.offline}</span> {t("agents_page.metric_offline").toLowerCase()}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
