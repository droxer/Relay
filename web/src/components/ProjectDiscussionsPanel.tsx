"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useProjectDiscussions, useProjectDiscussionPin } from "../hooks/useProjectDiscussions";
import { useQueueClock } from "../hooks/useQueueClock";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { PROJECT_LEAD_TOPICS, projectLeadTopicLabel, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import { mergeSessionSummaries } from "../lib/sessionPollMerge";
import { groupThreads } from "../lib/threadGroups";
import { threadNodeOffline } from "../lib/threadRuntime";
import { canDeleteThread, runningAgentName } from "../lib/threads";
import { pruneSelection, selectionCheckState, toggleAllSelected, toggleSelected } from "../lib/taskSelection";
import type { DaemonNodeMonitorRecord, RelaySession, UserAgent } from "../types";
import { ActionAdd, ActionPin, ChevronDownIcon, ICON, NavThreads } from "./icons";
import { ListSkeleton } from "./ListSkeleton";
import { ThreadRow } from "./ThreadRow";
import { TaskSelectionBar } from "./task-board/TaskSelection";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ButtonGroup, ButtonGroupSeparator } from "./ui/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { SearchInput } from "./ui/search-input";
import { WorkspaceEmpty, WorkspaceError } from "./workspace/WorkspacePrimitives";

export function ProjectDiscussionsPanel({
  projectId, archived, agents, computers, onOpenThread, onNewThread, onRenameThread,
  onCloseThread, onDeleteDiscussions, onDiscussWithLead, discussing,
}: {
  projectId: string;
  archived: boolean;
  agents: readonly UserAgent[];
  computers: readonly DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread?: () => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string, title?: string) => void;
  onDeleteDiscussions: (ids: readonly string[]) => Promise<readonly string[]>;
  onDiscussWithLead?: (topic?: ProjectLeadTopic) => void;
  discussing: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value);
  const query = useDebouncedValue(search.trim(), 250);
  const discussions = useProjectDiscussions(projectId, query);
  const pin = useProjectDiscussionPin(projectId);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const sessions = useMemo(() => mergeSessionSummaries([], discussions.sessions), [discussions.sessions]);
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
  const statusSections = [
    { tone: "attn", items: groups.needsYou, label: t("thread.group_needs_you") },
    { tone: "run", items: groups.running, label: t("thread.group_running") },
    { tone: "queued", items: groups.queued, label: t("thread.group_queued") },
    { tone: "idle", items: groups.idle, label: t("project.discussions_recent") },
  ] as const;
  const tones = new Map(statusSections.flatMap(({ tone, items }) => items.map(item => [item.session.id, tone] as const)));
  const sections = [
    { tone: "pinned", items: items.filter(item => item.session.discussionPinned), label: t("project.discussions_pinned") },
    ...statusSections.map(section => ({ ...section, items: section.items.filter(item => !item.session.discussionPinned) })),
  ];
  const showRecentHeading = sections.some(section => section.tone !== "idle" && section.items.length > 0);
  const selectableIds = sections.flatMap(section => section.items.filter(canDeleteThread).map(item => item.session.id));
  const checked = pruneSelection(selection, selectableIds);
  const checkState = selectionCheckState(checked, selectableIds);
  const filtered = query.length > 0 || search.trim().length > 0;
  const empty = discussions.loaded && items.length === 0;

  async function deleteSelected() {
    setDeleting(true);
    try {
      const ids = selectableIds.filter(id => checked.has(id));
      const accepted = new Set(await onDeleteDiscussions(ids));
      const remaining = ids.filter(id => !accepted.has(id));
      setSelection(new Set(remaining));
      if (!remaining.length) setSelecting(false);
    } finally {
      setDeleting(false);
    }
  }

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
      {(!empty || filtered || selecting) && <div className="project-discussions-toolbar">
        <SearchInput
          className="list-filter-search"
          iconSize={ICON.sm}
          label={t("project.discussions_search")}
          placeholder={t("project.discussions_search")}
          value={search}
          disabled={deleting}
          onChange={(event) => {
            setSelection(new Set());
            setSearch(event.currentTarget.value);
          }}
        />
        {(selectableIds.length > 0 || selecting) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={deleting || pin.isPending}
            onClick={() => {
              setSelecting(!selecting);
              setSelection(new Set());
            }}
          >
            {t(selecting ? "dialog.cancel" : "project.discussions_select")}
          </Button>
        )}
        {!empty && !selecting && actions}
      </div>}
      {selecting && !empty && (
        <label className="project-discussions-select-all">
          <Checkbox
            checked={checkState === "all"}
            indeterminate={checkState === "some"}
            disabled={deleting || !selectableIds.length}
            onCheckedChange={() => setSelection(toggleAllSelected(checked, selectableIds))}
          />
          {t("project.discussions_select_all")}
        </label>
      )}
      {discussions.isPending ? (
        <div className="project-discussions-skeleton" aria-busy="true">
          <ListSkeleton label={t("project.discussions_loading")} rows={3} />
        </div>
      ) : !discussions.loaded ? (
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
          {(tone !== "idle" || showRecentHeading) && (
            <h2 className="conversation-group-label">
              {tone === "pinned" && <ActionPin size={ICON.sm} aria-hidden="true" />}
              {label}
            </h2>
          )}
          <ul className="conversation-rows" aria-label={label}>
            {items.map(item => (
              <ThreadRow
                key={item.session.id}
                item={item}
                discussion
                selected={false}
                tone={tones.get(item.session.id) ?? "idle"}
                now={now}
                onSelect={onOpenThread}
                onRename={onRenameThread}
                onClose={onCloseThread}
                onSetDiscussionPin={(id, pinned) => pin.mutate({ id, pinned })}
                discussionPinPending={pin.isPending}
                discussionSelection={selecting ? {
                  checked: checked.has(item.session.id),
                  disabled: deleting,
                  onToggle: () => setSelection(current => toggleSelected(current, item.session.id)),
                } : undefined}
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
            disabled={discussions.isFetchingNextPage || pin.isPending || deleting}
            onClick={() => void discussions.fetchNextPage({ cancelRefetch: false })}
          >
            {t(discussions.isFetchingNextPage ? "project.discussions_loading" : "project.discussions_load_more")}
          </Button>
        </div>
      )}
      {selecting && (
        <TaskSelectionBar
          count={checked.size}
          deleting={deleting}
          onClear={() => setSelection(new Set())}
          onDelete={() => void deleteSelected()}
          deleteLabel={t("project.discussions_delete_selected")}
          selectedLabel={t("project.discussions_selected", { count: checked.size })}
        />
      )}
    </div>
  );
}
