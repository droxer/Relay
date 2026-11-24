"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { USER_AGENTS_QUERY_KEY, useUserAgents, userAgentRecordOptions } from "../hooks/useUserAgents";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { searchOwnAgents } from "../api-client/agents";
import { SearchInput } from "@/components/ui/search-input";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { agentMatchesQuery } from "../lib/agentSearch";
import { groupAgentsByComputer } from "../lib/agentGroups";
import type { CurrentUser, UserAgent } from "../types";
import { AgentMetaLine } from "./AgentMetaLine";
import { agentModel } from "../lib/agentModels";
import { AgentStateBadge } from "./AgentStateBadge";
import {
  ActionAdd,
  ICON,
  NavBack,
} from "./icons";
import { StateMark } from "./StateMark";
import { describeAgentRosterStatus } from "../lib/agentStatus";
import { AgentDetailPage } from "./AgentDetailPage";
import { MobileTopbarBack } from "./MobileTopbarSlot";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { Button } from "@/components/ui/button";
import { CreateAgentDialog } from "./agents/CreateAgentDialog";
import { ListSkeleton } from "./ListSkeleton";
import { ListRailResizeHandle } from "@/components/ListRailResize";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

interface AgentsPageProps {
  currentUser: CurrentUser;
  /** The agent currently inspected in the detail pane, driven by the pathname. */
  detailAgent: UserAgent | null;
  onOpenAgent: (agent: UserAgent) => void;
  onBackToAgents: () => void;
  onOpenThread: (sessionId: string) => void;
}

function RosterRow({
  agent,
  selected,
  onSelect,
}: {
  agent: UserAgent;
  selected: boolean;
  onSelect: (agent: UserAgent) => void;
}) {
  const { t } = useTranslation();
  const { availability, enabled } = agent;
  const rosterStatus = describeAgentRosterStatus(agent);
  const statusLabel = rosterStatus
    ? t(rosterStatus.key, rosterStatus.defaultValue ? { defaultValue: rosterStatus.defaultValue } : undefined)
    : null;

  return (
    <li className="list-virtual">
      <article
        className="agents-roster-row rail-row"
        data-availability={agent.availability}
        data-unavailable={rosterStatus?.unavailable ? "true" : undefined}
        data-selected={selected ? "true" : "false"}
      >
        <Button
          variant="ghost"
          type="button"
          className="agents-roster-row-select"
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelect(agent)}
        >
          <span className="agents-roster-row-badge" aria-hidden={statusLabel ? true : undefined}>
            <AgentStateBadge
              agent={agent.executorKind}
              ready={enabled && availability === "ready"}
              availability={enabled ? availability : undefined}
              imageUrl={agent.profileImageUrl}
              name={agent.displayName}
            />
          </span>
          <span className="agents-roster-row-main">
            <span className="agents-roster-row-title">
              <span className="agents-roster-row-name">{agent.displayName}</span>
            </span>
            {/* Status leads the secondary line instead of occupying a right-side
                pill column that crushes names in the 318px rail or 375px phone. */}
            <span className="agents-roster-row-sub">
              {rosterStatus && statusLabel ? (
                <>
                  <span className="agents-roster-row-state" data-tone={rosterStatus.tone}>
                    <StateMark shape={rosterStatus.shape} tone={rosterStatus.tone} />
                    <span>{statusLabel}</span>
                  </span>
                  <span className="agent-meta-separator" aria-hidden="true">·</span>
                </>
              ) : null}
              {/* The band above this row names the computer, so the row says
                  only which runtime it is — same trade the grouped task lists
                  made when the band took over the status column. */}
              <AgentMetaLine
                executorKind={agent.executorKind}
                placements={agent.placements}
                model={agentModel(agent)}
                className="agents-roster-row-meta"
                showComputers={false}
              />
            </span>
          </span>
        </Button>
      </article>
    </li>
  );
}

function AgentsPageView({
  currentUser,
  detailAgent,
  onOpenAgent,
  onBackToAgents,
  onOpenThread,
}: AgentsPageProps) {
  const { t } = useTranslation();
  const { agents, summarized, searchesInstructions, isFetching, error, refetch } = useUserAgents(currentUser.userId);
  const [query, setQuery] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null);
  const trimmedQuery = query.trim();
  const settledQuery = useDebouncedValue(trimmedQuery, 250);
  const waitForSearch = settledQuery !== trimmedQuery;
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.deletedAt),
    [agents],
  );
  const blurbs = useMemo(() => Object.fromEntries([...new Set(activeAgents.map(agent => agent.executorKind))]
    .map(kind => [kind, t(`agent.${kind}.blurb`)])), [activeAgents, t]);
  const searchEnabled = summarized && searchesInstructions && Boolean(trimmedQuery && activeAgents.length);
  const matchQuery = useQuery({
    queryKey: [USER_AGENTS_QUERY_KEY, currentUser.userId, "matches", settledQuery, blurbs],
    queryFn: ({ signal }) => searchOwnAgents(settledQuery, blurbs, signal),
    enabled: searchEnabled && !waitForSearch,
    staleTime: 30_000,
  });
  const matches = searchEnabled && !waitForSearch ? matchQuery.data?.agentIds : undefined;
  const recordId = detailAgent?.id;
  const detailQuery = useQuery({
    ...userAgentRecordOptions(recordId),
    enabled: summarized && Boolean(recordId),
    refetchInterval: RELAY_POLL_INTERVALS_MS.agents,
  });
  const record = detailQuery.data?.agent;
  const refetchRecord = detailQuery.refetch;
  const summaryVersion = detailAgent?.version;
  const recordVersion = record?.version;
  useEffect(() => {
    if (summarized && recordId && summaryVersion !== undefined && recordVersion !== undefined && recordVersion < summaryVersion) {
      void refetchRecord({ cancelRefetch: false });
    }
  }, [summarized, recordId, summaryVersion, recordVersion, refetchRecord]);
  const profile = summarized ? (record && detailAgent && record.version === detailAgent.version ? {
    ...record, availability: detailAgent.availability, bindingStatus: detailAgent.bindingStatus, placements: detailAgent.placements,
  } : record) : detailAgent;

  const visibleAgents = useMemo(() => {
    const matchingIds = matches ? new Set(matches) : null;
    return activeAgents
      .filter((agent) => matchingIds ? matchingIds.has(agent.id) : agentMatchesQuery(agent, blurbs[agent.executorKind], query))
      .sort((left, right) => {
        const rank = (agent: UserAgent) => {
          if (agent.availability === "ready") return 0;
          if (agent.availability === "busy") return 1;
          if (agent.availability === "pending") return 2;
          return 3;
        };
        const rankDelta = rank(left) - rank(right);
        if (rankDelta !== 0) return rankDelta;
        return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
      });
  }, [activeAgents, blurbs, matches, query]);

  const agentGroups = useMemo(() => groupAgentsByComputer(visibleAgents), [visibleAgents]);

  const loading = (isFetching && agents.length === 0)
    || (searchEnabled && (waitForSearch || matchQuery.isPending) && visibleAgents.length === 0);
  const searchError = searchEnabled && !waitForSearch && matchQuery.isError ? matchQuery.error.message : null;
  const listError = (agents.length === 0 && error) || searchError;
  const [createOpen, setCreateOpen] = useState(false);

  // All route changes share the editor's navigation guard, including the
  // mobile Back button, sidebar, and browser history.
  const handleSelectAgent = useCallback((agent: UserAgent) => {
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
        {/* Rail title: h2 like every list rail (the rail is a sidebar, not
            the page's heading) at the shared 17px rail-title rung. */}
        <PageHeader
          title={t("agents_page.title")}
          count={t("agents_page.sub", { count: activeAgents.length })}
          titleAs="h2"
          titleVariant="title"
          layout="stacked"
          topbarActions={detailAgent ? "inactive" : true}
          actions={
            currentUser.userId ? (
              // The shared list-header create affordance, same as the
              // projects/threads rail.
              <Button
                variant="ghost"
                type="button"
                className="page-header-icon-action page-header-icon-action--primary"
                tooltip={t("agents_page.create_action")}
                onClick={() => setCreateOpen(true)}
              >
                <ActionAdd size={ICON.md} aria-hidden="true" />
              </Button>
            ) : null
          }
        />

        <div className="list-filter-bar">
          <SearchInput
            className="list-filter-search"
            iconSize={ICON.sm}
            label={t("agents_page.search_label")}
            name="agents-query"
            value={query}
            placeholder={t("agents_page.search_placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {loading ? (
          <ListSkeleton label={t("admin.loading")} />
        ) : listError ? (
          <RelayEmptyState feature="agents"
            title={t("workspace.load_failed")}
            body={listError}
            actions={<Button type="button" variant="outline" onClick={() => void (searchError ? matchQuery.refetch() : refetch())}>{t("workspace.retry")}</Button>}
          />
        ) : visibleAgents.length === 0 ? (
          <RelayEmptyState feature="agents"
            title={activeAgents.length === 0 ? t("agents_page.empty_title") : t("agents_page.empty_filtered_title")}
            body={activeAgents.length === 0 ? t("agents_page.empty_body") : t("agents_page.empty_filtered_body")}
            actions={activeAgents.length === 0 && currentUser.userId ? <Button type="button" onClick={() => setCreateOpen(true)}>{t("agents_page.create_action")}</Button> : undefined}
          />
        ) : (
          // Banded by the computer each agent runs on — the infrastructure is
          // what a roster of agents is scanned against, and a computer hosts
          // many agents. Same bargain the grouped task lists struck: the band
          // names the fact, so the row stops repeating it.
          //
          // Compact density stays on each band's list: a 318px roster rail is
          // a list layout, so names sit one rung down (16 → 15px) beside their
          // 12px meta — the same treatment the backlog and admin tables get.
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
        <ListRailResizeHandle />
      </div>

      <div className="agents-detail">
        {detailAgent ? (
          <>
            {/* On a phone this is the top bar's back control ("← Agents"),
                not a second row under it. */}
            <MobileTopbarBack
              label={t("agents_page.title")}
              onBack={() => void handleBackToAgents()}
              fallback={(
                <Button
                  type="button"
                  variant="ghost"
                  className="agents-mobile-back"
                  onClick={() => void handleBackToAgents()}
                >
                  <NavBack size={ICON.sm} aria-hidden="true" />
                  {t("agents_page.title")}
                </Button>
              )}
            />
            {profile ? (
              <AgentDetailPage key={detailAgent.id} agent={profile} onOpenThread={onOpenThread} canEditMeta />
            ) : detailQuery.isError ? (
              <RelayEmptyState feature="agents" title={t("workspace.load_failed")} body={detailQuery.error.message}
                actions={<Button type="button" variant="outline" onClick={() => void refetchRecord()}>{t("workspace.retry")}</Button>} />
            ) : <ListSkeleton label={t("admin.loading")} />}
          </>
        ) : (
          <RelayEmptyState feature="agents"
            fill
            title={t("agents_page.select_title")}
            body={t("agents_page.select_body")}
          />
        )}
      </div>

      {currentUser.userId ? (
        <CreateAgentDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          userId={currentUser.userId}
          onCreated={onOpenAgent}
        />
      ) : null}
    </section>
  );
}

// Memoized: the shell re-renders on every streamed frame of a run that may
// be on another route; the roster reads nothing from it but the user.
export const AgentsPage = memo(AgentsPageView);
