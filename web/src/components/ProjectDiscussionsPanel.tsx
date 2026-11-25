"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useProjectDiscussions } from "../hooks/useProjectDiscussions";
import { useQueueClock } from "../hooks/useQueueClock";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import type { ProjectLeadTopic } from "../lib/projectLeadTopics";
import { mergeSessionSummaries } from "../lib/sessionPollMerge";
import { groupThreads } from "../lib/threadGroups";
import { parseThreadKindFilter } from "../lib/threadKindFilter";
import { threadNodeOffline } from "../lib/threadRuntime";
import { runningAgentName } from "../lib/threads";
import type { DaemonNodeMonitorRecord, RelaySession, UserAgent } from "../types";
import { ActionAdd, ICON, NavThreads } from "./icons";
import { LeadDiscussActions } from "./ProjectManagerLine";
import { ThreadRow } from "./ThreadRow";
import { Button } from "./ui/button";
import { SearchInput } from "./ui/search-input";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { WorkspaceEmpty, WorkspaceError } from "./workspace/WorkspacePrimitives";

const DISCUSSION_KINDS = ["all", "chats", "tasks"] as const;

export function ProjectDiscussionsPanel({
  projectId, archived, agents, computers, onOpenThread, onNewThread, onRenameThread,
  onCloseThread, onDiscussWithLead, discussing,
}: {
  projectId: string;
  archived: boolean;
  agents: readonly UserAgent[];
  computers: readonly DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread?: () => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string, title?: string) => void;
  onDiscussWithLead?: (topic?: ProjectLeadTopic) => void;
  discussing: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value);
  const [kind, setKind] = useUrlSearchState("kind", "all", parseThreadKindFilter, (value) => value);
  const query = useDebouncedValue(search.trim(), 250);
  const discussions = useProjectDiscussions(projectId, query, kind);
  const summaries = useMemo(() => {
    const seen = new Set<string>();
    return discussions.data?.pages.flatMap(page => page.sessions).filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }) ?? [];
  }, [discussions.data]);
  const sessions = useMemo(() => mergeSessionSummaries([], summaries), [summaries]);
  const counts = useMemo(() => new Map(summaries.map(row => [row.id, row.runCount])), [summaries]);
  const items = useMemo(() => {
    const running = new Map(computers.flatMap(node => node.activeRuns.map(run => [run.sessionId, run] as const)));
    const names = new Map(agents.map(agent => [agent.id, agent.displayName]));
    return sessions.map((session) => {
      const run = running.get(session.id);
      return {
        session,
        runningAgent: run?.agent,
        runningAgentName: runningAgentName(session, run, names),
        nodeOffline: threadNodeOffline(session, agents, computers),
        origin: session.taskActivity?.origin ?? undefined,
        taskAwaitsHuman: session.taskActivity?.awaitsHuman,
      };
    });
  }, [agents, computers, sessions]);
  const now = useQueueClock(sessions);
  const groups = groupThreads(items, [], now);
  const hasAttentionGroups = groups.needsYou.length > 0 || groups.running.length > 0 || groups.queued.length > 0;
  const sections = [
    { tone: "attn", items: groups.needsYou, label: t("thread.group_needs_you") },
    { tone: "run", items: groups.running, label: t("thread.group_running") },
    { tone: "queued", items: groups.queued, label: t("thread.group_queued") },
    { tone: "idle", items: groups.idle, label: t("project.discussions_recent") },
  ] as const;
  const filtered = query.length > 0 || kind !== "all";
  const empty = discussions.data !== undefined && items.length === 0;
  const actions = onNewThread ? (
    <div className="project-discussions-actions">
      <Button type="button" size="dense" onClick={onNewThread}>
        <ActionAdd size={ICON.sm} aria-hidden="true" />
        {t("project.discussions_new")}
      </Button>
      {onDiscussWithLead && (
        <LeadDiscussActions onDiscuss={onDiscussWithLead} discussing={discussing} label={t("project.discussions_with_lead")} />
      )}
    </div>
  ) : null;

  return (
    <div className="project-discussions" data-density="compact">
      <div className="project-discussions-toolbar">
        <SearchInput
          className="list-filter-search"
          label={t("project.discussions_search")}
          placeholder={t("project.discussions_search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <ToggleGroup
          className="thread-kind-filter"
          aria-label={t("thread.kind_filter_label")}
          value={[kind]}
          onValueChange={(next) => { if (next[0]) setKind(next[0]); }}
        >
          {DISCUSSION_KINDS.map(value => (
            <ToggleGroupItem key={value} value={value} className="thread-kind-filter-item">
              {t(value === "tasks" ? "project.discussions_task_runs" : `thread.kind_filter_${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {!empty && actions}
      </div>
      {discussions.isPending ? (
        <div className="project-discussions-skeleton" role="status" aria-busy="true">
          <span className="sr-only">{t("project.discussions_loading")}</span>
          {[0, 1, 2].map(index => (
            <div key={index} className="workspace-skeleton workspace-skeleton-line" aria-hidden="true" />
          ))}
        </div>
      ) : !discussions.data ? (
        <WorkspaceError message={t("project.discussions_load_failed")} onRetry={() => void discussions.refetch()} />
      ) : empty ? (
        <div className="project-discussions-empty">
          <WorkspaceEmpty
            title={t(filtered ? "project.discussions_no_matches" : "project.discussions_empty")}
            hint={filtered ? undefined : t(archived ? "project.discussions_archived" : onNewThread
              ? "project.discussions_empty_hint" : "project.discussions_read_only")}
            mark={<NavThreads size={ICON.md} aria-hidden="true" />}
            announce
          />
          {filtered ? (
            <Button type="button" variant="outline" size="dense" onClick={() => { setSearch(""); setKind("all"); }}>
              {t("backlog.clear_filters")}
            </Button>
          ) : actions}
        </div>
      ) : sections.map(({ tone, items, label }) => items.length > 0 && (
        <section key={tone} className="conversation-group" data-tone={tone}>
          {(tone !== "idle" || hasAttentionGroups) && <h2 className="conversation-group-label">{label}</h2>}
          <ul className="conversation-rows" aria-label={label}>
            {items.map(item => (
              <ThreadRow
                key={item.session.id}
                item={item}
                discussionRuns={counts.get(item.session.id) ?? 0}
                selected={false}
                tone={tone}
                now={now}
                onSelect={onOpenThread}
                onRename={onRenameThread}
                onClose={onCloseThread}
              />
            ))}
          </ul>
        </section>
      ))}
      {discussions.hasNextPage && (
        <div className="project-discussions-more">
          {discussions.isFetchNextPageError && <p role="alert">{t("project.discussions_load_older_failed")}</p>}
          <Button
            type="button"
            variant="outline"
            size="dense"
            disabled={discussions.isFetching}
            onClick={() => void discussions.fetchNextPage({ cancelRefetch: false })}
          >
            {t(discussions.isFetchingNextPage ? "project.discussions_loading" : "project.discussions_load_more")}
          </Button>
        </div>
      )}
    </div>
  );
}
