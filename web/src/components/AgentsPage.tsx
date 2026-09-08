"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { groupAgentsByComputer } from "../lib/agentGroups";
import { agentMatchesQuery } from "../lib/agentSearch";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import type { AgentName, CurrentUser, EmployeeAgent, LogicalAgentAvailability } from "../types";
import { AgentMetaLine } from "./AgentMetaLine";
import { AgentStateBadge } from "./AgentStateBadge";
import {
  ActionAdd,
  ICON,
  NavBack,
} from "./icons";
import { StatusPill, TonePill } from "./StatusPill";
import { AgentDetailPage } from "./AgentDetailPage";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "./FiltersBar";
import { SearchInput } from "@/components/ui/search-input";
import { CreateAgentDialog } from "./agents/CreateAgentDialog";

interface AgentsPageProps {
  currentUser: CurrentUser;
  /** The agent currently inspected in the detail pane, driven by the pathname. */
  detailAgent: EmployeeAgent | null;
  onOpenAgent: (agent: EmployeeAgent) => void;
  onBackToAgents: () => void;
  onOpenThread: (sessionId: string) => void;
}

type AvailabilityFilter = "all" | LogicalAgentAvailability;

const AVAILABILITY_FILTERS: readonly AvailabilityFilter[] = [
  "all",
  "ready",
  "busy",
  "pending",
  "offline",
];

function parseAvailabilityFilter(value: string | null): AvailabilityFilter {
  return AVAILABILITY_FILTERS.includes(value as AvailabilityFilter)
    ? value as AvailabilityFilter
    : "all";
}

function agentDescriptors(t: ReturnType<typeof useTranslation>["t"]):
Record<AgentName, { blurb: string }> {
  return {
    claude: { blurb: t("agent.claude.blurb") },
    pi: { blurb: t("agent.pi.blurb") },
    codex: { blurb: t("agent.codex.blurb") },
    kimi: { blurb: t("agent.kimi.blurb") },
  };
}

function RosterFilterBar({
  query,
  availability,
  onQueryChange,
  onAvailabilityChange,
}: {
  query: string;
  availability: AvailabilityFilter;
  onQueryChange: (value: string) => void;
  onAvailabilityChange: (value: AvailabilityFilter) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="list-filter-bar" role="group" aria-label={t("agents_page.filters")}>
      <SearchInput
        className="list-filter-search"
        iconSize={ICON.sm}
        label={t("agents_page.search_label")}
        name="agents-query"
        value={query}
        placeholder={t("agents_page.search_placeholder")}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <FilterSelect
        className="agents-roster-select"
        name="agents-availability-filter"
        label={t("agents_page.filter_availability")}
        value={availability}
        onValueChange={onAvailabilityChange}
        options={AVAILABILITY_FILTERS.map((filter) => ({
          value: filter,
          label: t(`agents_page.filter_${filter}`),
        }))}
      />
    </div>
  );
}

/** "available" is the healthy default and stays silent — only the three
    unusable bindings get a badge, so the roster surfaces a defect instead
    of quietly leaving an agent unreachable. */
function BindingStatusBadge({ status }: { status: EmployeeAgent["bindingStatus"] }) {
  const { t } = useTranslation();
  if (!status || status === "available") return null;
  return (
    <TonePill tone="bad" label={t(`agents_page.binding_status_${status}`)} />
  );
}

function RosterRow({
  agent,
  selected,
  onSelect,
}: {
  agent: EmployeeAgent;
  selected: boolean;
  onSelect: (agent: EmployeeAgent) => void;
}) {
  const { t } = useTranslation();
  const ready = agent.enabled && agent.availability === "ready";

  return (
    <li className="list-virtual">
      <article
        className="agents-roster-row rail-row"
        data-availability={agent.availability}
        data-selected={selected ? "true" : "false"}
      >
        <Button
          variant="ghost"
          type="button"
          className="agents-roster-row-select"
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelect(agent)}
        >
          <span className="agents-roster-row-badge">
            <AgentStateBadge
              agent={agent.executorKind}
              ready={ready}
              availability={agent.enabled ? agent.availability : undefined}
              imageUrl={agent.profileImageUrl}
              name={agent.displayName}
            />
          </span>
          <span className="agents-roster-row-main">
            <span className="agents-roster-row-title">
              <span className="agents-roster-row-name">{agent.displayName}</span>
            </span>
            {/* The band above this row names the computer, so the row says
                only which runtime it is — same trade the grouped task lists
                made when the band took over the status column. */}
            <AgentMetaLine
              executorKind={agent.executorKind}
              placements={agent.placements}
              className="agents-roster-row-meta"
              showComputers={false}
            />
          </span>
          {/* One row, ONE place for status. Disabled used to render as a Badge
              inline after the name while Busy / Pending / Offline rendered in
              this trailing slot, so the same category of information had two
              landing points depending on which value it took. Explicit status
              only when it adds information — "ready" is the default healthy
              state, already carried by the badge pip. */}
          {!agent.enabled ? (
            <span className="agents-roster-row-status">
              <TonePill tone="neutral" label={t("agents_page.disabled")} />
            </span>
          ) : agent.availability !== "ready" ? (
            <span className="agents-roster-row-status">
              <StatusPill value={agent.availability} />
            </span>
          ) : null}
          <BindingStatusBadge status={agent.bindingStatus} />
        </Button>
      </article>
    </li>
  );
}

export function AgentsPage({
  currentUser,
  detailAgent,
  onOpenAgent,
  onBackToAgents,
  onOpenThread,
}: AgentsPageProps) {
  const { t } = useTranslation();
  const { agents, isFetching, error, refetch } = useEmployeeAgents(currentUser.employeeId);
  const descriptors = useMemo(() => agentDescriptors(t), [t]);
  const [query, setQuery] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null);
  const [availability, setAvailability] = useUrlSearchState(
    "availability",
    "all" as AvailabilityFilter,
    parseAvailabilityFilter,
    (value) => value === "all" ? null : value,
  );
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.deletedAt),
    [agents],
  );

  const visibleAgents = useMemo(() => {
    return activeAgents
      .filter((agent) => availability === "all" || agent.availability === availability)
      .filter((agent) => agentMatchesQuery(agent, descriptors[agent.executorKind].blurb, query))
      .sort((left, right) => {
        const rank = (agent: EmployeeAgent) => {
          if (agent.availability === "ready") return 0;
          if (agent.availability === "busy") return 1;
          if (agent.availability === "pending") return 2;
          return 3;
        };
        const rankDelta = rank(left) - rank(right);
        if (rankDelta !== 0) return rankDelta;
        return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
      });
  }, [activeAgents, availability, descriptors, query]);

  const agentGroups = useMemo(() => groupAgentsByComputer(visibleAgents), [visibleAgents]);

  const loading = isFetching && agents.length === 0;
  const [createOpen, setCreateOpen] = useState(false);

  // All route changes share the editor's navigation guard, including the
  // mobile Back button, sidebar, and browser history.
  const handleSelectAgent = useCallback((agent: EmployeeAgent) => {
    if (agent.id !== detailAgent?.id) onOpenAgent(agent);
  }, [detailAgent?.id, onOpenAgent]);
  const handleBackToAgents = onBackToAgents;

  return (
    <section
      id="agents-panel"
      className="agents-page"
      data-view={detailAgent ? "detail" : "list"}
      aria-label={t("agents_page.title")}
      tabIndex={-1}
    >
      <div className="agents-roster" aria-label={t("agents_page.title")}>
        {/* Agents was the only primary route with no PageHeader — it rendered
            with zero headings in the document, so the panel had no title and
            the page had no h1 for the accessibility tree. Mirrors TeamsPage. */}
        <PageHeader
          kicker={t("nav.workforce")}
          title={t("agents_page.title")}
          count={t("agents_page.sub", { count: activeAgents.length })}
          titleVariant="display"
          layout="stacked"
          actions={
            currentUser.employeeId ? (
              // The shared list-header create affordance — a ghost plus, same
              // as the projects/threads rail.
              <Button
                variant="ghost"
                type="button"
                className="page-header-icon-action"
                tooltip={t("agents_page.create_action")}
                onClick={() => setCreateOpen(true)}
              >
                <ActionAdd size={ICON.md} aria-hidden="true" />
              </Button>
            ) : null
          }
        />

        <RosterFilterBar
          query={query}
          availability={availability}
          onQueryChange={setQuery}
          onAvailabilityChange={setAvailability}
        />

        {loading ? (
          <div className="route-loading" role="status" aria-live="polite">
            {t("admin.loading")}
          </div>
        ) : error && agents.length === 0 ? (
          <RelayEmptyState
            title={t("workspace.load_failed")}
            body={error}
            actions={<Button type="button" variant="outline" onClick={() => void refetch()}>{t("workspace.retry")}</Button>}
          />
        ) : visibleAgents.length === 0 ? (
          <RelayEmptyState
            title={activeAgents.length === 0 ? t("agents_page.empty_title") : t("agents_page.empty_filtered_title")}
            body={activeAgents.length === 0 ? t("agents_page.empty_body") : t("agents_page.empty_filtered_body")}
          />
        ) : (
          // Banded by the computer each agent runs on — the infrastructure is
          // what a roster of agents is scanned against, and a computer hosts
          // many agents. Same bargain the grouped task lists struck: the band
          // names the fact, so the row stops repeating it.
          //
          // Compact density stays on each band's list: a 318px roster rail is
          // a list layout, so names sit one rung down (16 → 15px) beside their
          // 13px meta — the same treatment the backlog and admin tables get.
          <div className="agents-roster-groups">
            {agentGroups.map((group) => {
              const label = group.label ?? t("agents_page.group_unplaced");
              return (
                <div key={group.key} className="agents-roster-group">
                  <div className="agents-roster-group-label">
                    <span translate={group.label ? "no" : undefined}>{label}</span>
                    <span className="agents-roster-group-count tnum">{group.agents.length}</span>
                  </div>
                  <ul className="agents-roster-list" data-density="compact" aria-label={label}>
                    {group.agents.map((agent) => (
                      <RosterRow
                        key={agent.id}
                        agent={agent}
                        selected={detailAgent?.id === agent.id}
                        onSelect={(agent) => void handleSelectAgent(agent)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="agents-detail">
        {detailAgent ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="agents-mobile-back"
              onClick={() => void handleBackToAgents()}
            >
              <NavBack size={ICON.sm} aria-hidden="true" />
              {t("agents_page.title")}
            </Button>
            <AgentDetailPage
              key={detailAgent.id}
              agent={detailAgent}
              onOpenThread={onOpenThread}
              canEditMeta
            />
          </>
        ) : (
          <RelayEmptyState
            fill
            title={t("agents_page.select_title")}
            body={t("agents_page.select_body")}
          />
        )}
      </div>

      {currentUser.employeeId ? (
        <CreateAgentDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          employeeId={currentUser.employeeId}
          onCreated={onOpenAgent}
        />
      ) : null}
    </section>
  );
}
