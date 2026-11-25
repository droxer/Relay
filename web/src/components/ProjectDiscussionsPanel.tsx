"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useProjectDiscussions } from "../hooks/useProjectDiscussions";
import { useQueueClock } from "../hooks/useQueueClock";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { PROJECT_LEAD_TOPICS, projectLeadTopicLabel, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import { mergeSessionSummaries } from "../lib/sessionPollMerge";
import { groupThreads } from "../lib/threadGroups";
import { threadNodeOffline } from "../lib/threadRuntime";
import { runningAgentName } from "../lib/threads";
import type { DaemonNodeMonitorRecord, RelaySession, UserAgent } from "../types";
import { ActionAdd, ChevronDownIcon, ICON, NavThreads } from "./icons";
import { ListSkeleton } from "./ListSkeleton";
import { ThreadRow } from "./ThreadRow";
import { Button } from "./ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "./ui/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { SearchInput } from "./ui/search-input";
import { WorkspaceEmpty, WorkspaceError } from "./workspace/WorkspacePrimitives";

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
  const query = useDebouncedValue(search.trim(), 250);
  const discussions = useProjectDiscussions(projectId, query);
  const summaries = useMemo(() => {
    const seen = new Set<string>();
    return discussions.data?.pages.flatMap(page => page.sessions).filter(row => {
      if (row.taskActivity?.origin || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }) ?? [];
  }, [discussions.data]);
  const sessions = useMemo(() => mergeSessionSummaries([], summaries), [summaries]);
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
  const filtered = query.length > 0 || search.trim().length > 0;
  const empty = discussions.data !== undefined && items.length === 0;
  const newDiscussion = onNewThread ? (
    <Button type="button" size="sm" onClick={onNewThread}>
      <ActionAdd size={ICON.sm} aria-hidden="true" />
      {t("project.discussions_new")}
    </Button>
  ) : null;
  const actions = newDiscussion && onDiscussWithLead ? (
    <ButtonGroup aria-label={t("project.discussions_new")}>
      {newDiscussion}
      <ButtonGroupSeparator />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={discussing}
          render={(
            <Button type="button" size="icon-sm" aria-label={t("project_manager.quick_topics")}>
              <ChevronDownIcon size={ICON.sm} aria-hidden="true" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onDiscussWithLead()}>{t("project.discussions_with_lead")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          {PROJECT_LEAD_TOPICS.map(topic => (
            <DropdownMenuItem key={topic} onClick={() => onDiscussWithLead(topic)}>
              {projectLeadTopicLabel(t, topic)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  ) : newDiscussion;

  return (
    <div className="project-discussions">
      {(!empty || filtered) && <div className="project-discussions-toolbar">
        <SearchInput
          className="list-filter-search"
          iconSize={ICON.sm}
          label={t("project.discussions_search")}
          placeholder={t("project.discussions_search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        {!empty && actions}
      </div>}
      {discussions.isPending ? (
        <div className="project-discussions-skeleton" aria-busy="true">
          <ListSkeleton label={t("project.discussions_loading")} rows={3} />
        </div>
      ) : !discussions.data ? (
        <WorkspaceError message={t("project.discussions_load_failed")} onRetry={() => void discussions.refetch()} />
      ) : empty ? (
        <WorkspaceEmpty
          title={t(filtered ? "project.discussions_no_matches" : "project.discussions_empty")}
          hint={filtered ? undefined : t(archived ? "project.discussions_archived" : onNewThread
            ? "project.discussions_empty_hint" : "project.discussions_read_only")}
          mark={<NavThreads size={ICON.md} aria-hidden="true" />}
          actions={filtered ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setSearch("")}>
              {t("backlog.clear_filters")}
            </Button>
          ) : actions}
          announce
        />
      ) : sections.map(({ tone, items, label }) => items.length > 0 && (
        <section key={tone} className="conversation-group" data-tone={tone}>
          {(tone !== "idle" || hasAttentionGroups) && <h2 className="conversation-group-label">{label}</h2>}
          <ul className="conversation-rows" aria-label={label}>
            {items.map(item => (
              <ThreadRow
                key={item.session.id}
                item={item}
                discussion
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
