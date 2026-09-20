import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionAdd,
  ICON,
  NavProjects,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { RelayEmptyState } from "./RelayEmptyState";
import { ThreadRow, type ThreadItem } from "./ThreadRow";
import { groupThreads } from "../lib/threadGroups";
import { limitThreadGroups, railLimitFor, RAIL_PAGE_SIZE } from "../lib/threads";
import { useStableCallback } from "@/hooks/useStableCallback";
import { projectThreadBuckets } from "../lib/threads";
import {
  projectDirectoryState,
  projectFolderSelection,
} from "../lib/projectDirectory";
import {
  clampThreadListWidth,
  maxThreadListWidth,
  THREAD_LIST_WIDTH_DEFAULT,
  THREAD_LIST_WIDTH_MAX,
  THREAD_LIST_WIDTH_MIN,
} from "../lib/threadList";
import type { DaemonNodeMonitorRecord, ProjectRecord, RelaySession } from "../types";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import { useChatColumnResize } from "@/hooks/useChatColumnResize";
import { chatColumnWidth, viewportWidth } from "@/lib/shellMetrics";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";

// The logged-in employee's own threads. Each row is a session; the list
// is owner-scoped by the backend, so it only ever shows the current employee's
// work. “New thread” starts a fresh thread without archiving the rest.
export function ThreadListPanel({
  directoryMode,
  threads,
  projects,
  projectsStatus,
  projectsError,
  onRetryProjects,
  computers,
  query,
  setQuery,
  selectedSessionId,
  selectedProjectId,
  onSelectThread,
  onSelectProject,
  onCreateProject,
  onNewThread,
  onRenameThread,
  onCloseThread,
  width,
  onResize,
  onResizeActive,
}: {
  directoryMode: "threads" | "projects";
  threads: ThreadItem[];
  projects: ProjectRecord[];
  /** The projects query's state, the same one the detail pane resolves its
   *  loading / error / not-found panes from. The rail must not answer "no
   *  projects yet" for a fetch that has not finished or has failed. */
  projectsStatus: ProjectCollectionStatus;
  projectsError: string;
  onRetryProjects: () => void;
  computers: DaemonNodeMonitorRecord[];
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  selectedSessionId: string | undefined;
  selectedProjectId: string | null;
  onSelectThread: (sessionId: string) => void;
  onSelectProject: (projectId: string | null) => void;
  onCreateProject: () => void;
  onNewThread: (projectId?: string | null) => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string) => void;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  // Rows are memoized; App rebuilds these handlers on every render.
  const selectThread = useStableCallback(onSelectThread);
  const renameThread = useStableCallback(onRenameThread);
  const closeThread = useStableCallback(onCloseThread);
  const now = useMinuteClock();
  /* Ceiling measured against the live chat column — read once per gesture and
     once per key press, never per pointer move. */
  const listCeiling = useCallback(() => maxThreadListWidth(width, chatColumnWidth(), viewportWidth()), [width]);

  // Anything that narrows the chat column while the list is at a custom width
  // can push it under its floor — a narrowed window, but equally an expanding
  // side rail; give the room back rather than leaving the conversation
  // squeezed. Only ever shrinks — maxThreadListWidth is a ceiling, not a
  // target — and never commits, so a transient squeeze doesn't overwrite the
  // width the user actually chose.
  useChatColumnResize(useCallback(() => {
    const max = maxThreadListWidth(width, chatColumnWidth(), viewportWidth());
    if (width > max) onResize(max, false);
  }, [onResize, width]));

  const hierarchy = projectThreadBuckets(threads, projects);
  const directoryState = projectDirectoryState({
    projectCount: hierarchy.projects.length,
    collectionStatus: projectsStatus,
    hasQuery: query.trim().length > 0,
  });

  const railWindow = useRailWindow(hierarchy.unclassified, selectedSessionId, query);

  const renderThreads = () => {
    const { groups: limited, sentinelRef, limit } = railWindow;
    const sections = [
      { key: "needsYou", tone: "attn", label: t("thread.group_needs_you"), group: limited.needsYou },
      { key: "running", tone: "run", label: t("thread.group_running"), group: limited.running },
      { key: "idle", tone: "idle", label: t("thread.group_idle"), group: limited.idle },
    ] as const;
    return [...sections.map(({ group, ...section }) => group.items.length > 0 ? (
      <div key={section.key} className="conversation-group" data-tone={section.tone}>
        <div className="conversation-group-label">
          <span>{section.label}</span>
          {/* The group's full count, not the mounted rows — the rail mounts a
              window and grows it as the reader scrolls. */}
          <span className="conversation-group-count tnum">{group.total}</span>
        </div>
        {/* Rows are <li>s, so each group carries its own list. The group label
            names it rather than sitting inside it — a heading is not a row. */}
        <ul className="conversation-rows" aria-label={section.label}>
          {group.items.map((item) => (
            <ThreadRow
              key={item.session.id}
              item={item}
              tone={section.tone}
              selected={selectedSessionId === item.session.id}
              onSelect={selectThread}
              onRename={renameThread}
              onClose={closeThread}
              now={now}
            />
          ))}
        </ul>
      </div>
    ) : null),
    limited.hasMore ? <div key={`more-${limit}`} ref={sentinelRef} className="conversation-rail-sentinel" aria-hidden="true" /> : null];
  };

  return (
    // Compact density: the rail is a list layout, so thread and project names
    // sit one rung down (16 → 15px) against their 13px meta — the same
    // treatment the agent roster and teams table get.
    <aside id="thread-panel" className="thread-panel" aria-label={t(directoryMode === "projects" ? "project.projects" : "nav.threads")} tabIndex={-1} data-density="compact">
      <div className="thread-panel-inner">
      {/* Same frame as every other list rail: PageHeader over a
          .list-filter-bar band, each carrying its own hairline. */}
      <PageHeader
        title={directoryMode === "projects" ? t("project.projects") : t("nav.threads")}
        count={directoryMode === "projects" ? hierarchy.projects.length : threads.length}
        titleVariant="display"
        actions={(() => {
          // One ghost plus for both modes — the shared list-header create
          // affordance (.page-header-icon-action, shell.css).
          const createLabel = directoryMode === "projects" ? t("project.create") : t("thread.new_thread");
          return (
            <Button variant="ghost"
              type="button"
              className="page-header-icon-action"
              tooltip={createLabel}
              onClick={directoryMode === "projects" ? onCreateProject : () => onNewThread(null)}
            >
              <ActionAdd size={ICON.md} />
            </Button>
          );
        })()}
      />
      <div className="list-filter-bar">
        <SearchInput
          className="list-filter-search"
          iconSize={ICON.sm}
          label={directoryMode === "projects" ? t("project.search_label") : t("thread.search_label")}
          name="thread-search"
          placeholder={directoryMode === "projects" ? t("project.search_placeholder") : t("thread.search_placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <section
        // project-directory widens the row gap for folder blocks; in threads
        // mode the list must keep conversation-list's tight single-line gap.
        className={directoryMode === "projects" ? "conversation-list project-directory" : "conversation-list"}
        aria-label={directoryMode === "projects" ? t("project.projects") : t("nav.threads")}
      >
        {directoryMode === "projects" ? hierarchy.projects.map(({ project, threads: projectThreads }) => {
          const computerLabel = computers.find((computer) => computer.id === project.computerId)?.displayName
            || project.computerId.replace(/^device:[^:]+:/, "");
          const selection = projectFolderSelection({
            projectId: project.id,
            selectedProjectId,
            selectedSessionId,
            threadIds: projectThreads.map((item) => item.session.id),
          });
          return (
          <section key={project.id} className={`project-folder${selection ? ` ${selection}` : ""}${project.archivedAt ? " archived" : ""}`}>
            {/* The folder header is a rail row like any other — `.rail-row` +
                data-selected is the one place the wash and the leading accent
                are defined (tokens/base.css), shared with thread, agent and
                team rows. */}
            <div
              className="project-folder-header rail-row"
              data-selected={selection === "selected" ? "true" : "false"}
            >
              <Button
                variant="ghost"
                type="button"
                className="project-folder-select"
                aria-current={selection === "selected" ? "page" : undefined}
                tooltip={`${project.name} · ${t("project.member_count", { count: project.members.length })} · ${computerLabel}`}
                aria-label={project.name}
                onClick={() => onSelectProject(project.id)}
              >
                <span className="project-folder-icon">
                  <NavProjects size={ICON.sm} aria-hidden="true" />
                </span>
                <span className="project-folder-name">{project.name}</span>
                <span className="project-folder-count">{t(project.archivedAt ? "project.state_archived" : project.enabled ? "project.state_active" : "project.state_disabled")}</span>
              </Button>
            </div>
          </section>
        )}) : renderThreads()}
        {/* The rail is too narrow for a doodle, so the vignette is dropped;
            a filtered-empty list offers no create action, because creating
            would not answer the question the query asked. */}
        {directoryMode === "projects" ? (
          // Loading and error are their own answers here, matching the detail
          // pane beside it — an unfinished or failed fetch is not an empty
          // account, and offering "Create project" for one is a lie.
          directoryState === "loading" ? (
            <div className="route-loading" role="status" aria-live="polite">
              {t("project.loading")}
            </div>
          ) : directoryState === "error" ? (
            <RelayEmptyState
              className="conversation-empty"
              title={t("project.load_failed")}
              body={projectsError || t("project.load_failed_body")}
              actions={(
                <Button type="button" variant="outline" onClick={onRetryProjects}>
                  {t("workspace.retry")}
                </Button>
              )}
            />
          ) : directoryState === "filtered-empty" ? (
            <RelayEmptyState
              className="conversation-empty"
              title={t("thread.no_matches")}
            />
          ) : directoryState === "empty" ? (
            <RelayEmptyState
              className="conversation-empty"
              title={t("project.no_projects")}
              actions={(
                <Button type="button" onClick={() => onCreateProject()}>
                  {t("project.create")}
                </Button>
              )}
            />
          ) : null
        ) : threads.length === 0 ? (
          <RelayEmptyState
            className="conversation-empty"
            title={query.trim() ? t("thread.no_matches") : t("thread.no_threads")}
            actions={query.trim() ? undefined : (
              <Button type="button" onClick={() => onNewThread(null)}>
                {t("thread.new_thread")}
              </Button>
            )}
          />
        ) : null}
      </section>
      </div>
      <ResizeHandle
        className="thread-panel-resize"
        label={t("thread.resize_label")}
        width={width}
        min={THREAD_LIST_WIDTH_MIN}
        max={THREAD_LIST_WIDTH_MAX}
        defaultWidth={THREAD_LIST_WIDTH_DEFAULT}
        /* The list sits left of the chat column, so dragging right grows it —
           the mirror of the space panel's leftward drag. */
        grows="inline-end"
        clamp={clampThreadListWidth}
        ceiling={listCeiling}
        onResize={onResize}
        onResizeActive={onResizeActive}
      />
    </aside>
  );
}

const MINUTE_MS = 60_000;

/** Date.now(), refreshed once a minute — the only clock the rail's stamps read. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The rows the threads rail mounts: whole pages, in attention order, grown by
 * a sentinel as it scrolls into view. 400 threads used to mount 400 rows and
 * ~20k DOM nodes. The window always reaches the selected thread, so opening
 * one from a link still shows it highlighted in the rail. It restarts at one
 * page when the query changes, since a filter is a new list.
 */
function useRailWindow(items: ThreadItem[], selectedSessionId: string | undefined, query: string) {
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [query]);

  const groups = useMemo(() => groupThreads(items), [items]);
  const selectedIndex = useMemo(() => {
    if (!selectedSessionId) return -1;
    return [...groups.needsYou, ...groups.running, ...groups.idle]
      .findIndex((item) => item.session.id === selectedSessionId);
  }, [groups, selectedSessionId]);
  const limit = Math.max(pages * RAIL_PAGE_SIZE, railLimitFor(selectedIndex, RAIL_PAGE_SIZE));
  const limited = useMemo(() => limitThreadGroups(groups, limit), [groups, limit]);

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver(
      (entries) => {
        // A deep-linked selection can extend the mounted window beyond pages.
        // Grow from that effective limit so every intersection reveals rows.
        if (entries.some((entry) => entry.isIntersecting)) {
          setPages((current) => Math.max(current, limit / RAIL_PAGE_SIZE) + 1);
        }
      },
      // Grow a screen early so scrolling never meets the end of the window.
      { root: node.closest(".conversation-list"), rootMargin: "0px 0px 600px 0px" },
    );
    observer.current.observe(node);
  }, [limit]);
  // The sentinel is keyed by the limit, so each growth mounts a fresh node and
  // the observer reports its initial intersection — a sentinel still in range
  // after a page lands grows the window again instead of stalling.
  useEffect(() => () => observer.current?.disconnect(), []);

  return { groups: limited, sentinelRef, limit };
}
