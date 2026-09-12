import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StateMark } from "./StateMark";
import {
  ActionAdd,
  ChevronDownIcon,
  ICON,
  WorkspaceFolder,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { ThreadRow, type ThreadItem } from "./ThreadRow";
import { groupThreads } from "../lib/threadGroups";
import { projectThreadBuckets } from "../lib/threads";
import {
  expandProject,
  isProjectExpanded,
  projectDirectoryState,
  projectEmptyKey,
  projectFolderSelection,
  projectFolderTone,
  readProjectExpansion,
  toggleProjectExpansion,
  writeProjectExpansion,
  type ProjectExpansion,
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
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";

const KEYBOARD_RESIZE_STEP = 16;

/** The chat column, measured to work out how much width the list may still
 *  take. Read straight from the DOM rather than threaded down as a prop: the
 *  grid — not React — owns the column's real width. */
function chatWidth(): number | null {
  if (typeof document === "undefined") return null;
  const chat = document.getElementById("chat-panel");
  return chat ? chat.getBoundingClientRect().width : null;
}

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
  // Which folders are open, remembered across reloads. Read after mount
  // rather than in the initializer: the export is prerendered, so touching
  // localStorage during the first render mismatches hydration.
  const [expansion, setExpansion] = useState<ProjectExpansion>({});
  useEffect(() => setExpansion(readProjectExpansion()), []);

  const applyExpansion = useCallback((next: ProjectExpansion) => {
    setExpansion(next);
    writeProjectExpansion(next);
  }, []);

  // A drag registers listeners outside React; this releases them if the panel
  // unmounts mid-gesture, which would otherwise leak the listeners and strand
  // the shell in its resizing state.
  const releaseDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseDragRef.current?.(), []);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    // Ceiling fixed at gesture start: the chat column shrinks as the drag
    // proceeds, so re-measuring per move would let the list walk past it.
    const max = maxThreadListWidth(width, chatWidth());
    handle.setPointerCapture(event.pointerId);
    onResizeActive(true);

    // The list sits left of the chat column, so dragging right (positive
    // delta) grows it — the mirror of the space panel's leftward drag.
    const widthAt = (clientX: number) => clampThreadListWidth(width + (clientX - startX), max);
    const move = (moveEvent: PointerEvent) => onResize(widthAt(moveEvent.clientX), false);
    const finish = (finalX: number | null) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      releaseDragRef.current = null;
      if (finalX !== null) onResize(widthAt(finalX), true);
      onResizeActive(false);
    };
    const up = (upEvent: PointerEvent) => finish(upEvent.clientX);
    // A cancelled gesture (system takeover, touch interruption) never fires
    // pointerup — without this the shell keeps its resizing state forever.
    const cancel = () => finish(null);

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    releaseDragRef.current = () => finish(null);
  }, [onResize, onResizeActive, width]);

  const resizeByKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const max = maxThreadListWidth(width, chatWidth());
    if (event.key === "Home") {
      event.preventDefault();
      onResize(clampThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, max), true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    onResize(clampThreadListWidth(width + delta, max), true);
  }, [onResize, width]);

  // Anything that narrows the chat column while the list is at a custom width
  // can push it under its floor — a narrowed window, but equally an expanding
  // side rail; give the room back rather than leaving the conversation
  // squeezed. Only ever shrinks — maxThreadListWidth is a ceiling, not a
  // target — and never commits, so a transient squeeze doesn't overwrite the
  // width the user actually chose.
  useChatColumnResize(useCallback(() => {
    const max = maxThreadListWidth(width, chatWidth());
    if (width > max) onResize(max, false);
  }, [onResize, width]));

  const hierarchy = projectThreadBuckets(threads, projects);
  const directoryState = projectDirectoryState({
    projectCount: hierarchy.projects.length,
    collectionStatus: projectsStatus,
    hasQuery: query.trim().length > 0,
  });

  const renderThreads = (items: ThreadItem[]) => {
    const groups = groupThreads(items);
    const sections = [
      { key: "needsYou", tone: "attn", label: t("thread.group_needs_you"), items: groups.needsYou },
      { key: "running", tone: "run", label: t("thread.group_running"), items: groups.running },
      { key: "idle", tone: "idle", label: t("thread.group_idle"), items: groups.idle },
    ] as const;
    return sections.map((section) => section.items.length > 0 ? (
      <div key={section.key} className="conversation-group" data-tone={section.tone}>
        <div className="conversation-group-label">
          <span>{section.label}</span>
          <span className="conversation-group-count tnum">{section.items.length}</span>
        </div>
        {/* Rows are <li>s, so each group carries its own list. The group label
            names it rather than sitting inside it — a heading is not a row. */}
        <ul className="conversation-rows" aria-label={section.label}>
          {section.items.map((item) => (
            <ThreadRow
              key={item.session.id}
              item={item}
              tone={section.tone}
              selected={selectedSessionId === item.session.id}
              onSelect={onSelectThread}
              onRename={onRenameThread}
              onClose={onCloseThread}
            />
          ))}
        </ul>
      </div>
    ) : null);
  };

  // Threads inside a project render flat: the group headers that make sense
  // for a long unscoped list are pure chrome around one to five rows, so the
  // attention order (needs you → running → idle) is kept but the grouping is
  // dropped and each row carries its own state pip instead.
  const renderProjectThreads = (items: ThreadItem[]) => {
    const groups = groupThreads(items);
    const flat: Array<{ item: ThreadItem; state: "attn" | "run" | "idle" }> = [
      ...groups.needsYou.map((item) => ({ item, state: "attn" as const })),
      ...groups.running.map((item) => ({ item, state: "run" as const })),
      ...groups.idle.map((item) => ({ item, state: "idle" as const })),
    ];
    return (
      <ul className="conversation-rows">
        {flat.map(({ item, state }) => (
          <ThreadRow
            key={item.session.id}
            item={item}
            tone={state}
            layout="nested"
            selected={selectedSessionId === item.session.id}
            onSelect={onSelectThread}
            onRename={onRenameThread}
            onClose={onCloseThread}
          />
        ))}
      </ul>
    );
  };

  return (
    // Compact density: the rail is a list layout, so thread and project names
    // sit one rung down (16 → 15px) against their 13px meta — the same
    // treatment the agent roster and teams table get.
    <aside id="thread-panel" className="thread-panel" aria-label={t("nav.threads")} tabIndex={-1} data-density="compact">
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
          const expanded = isProjectExpanded(project, expansion);
          const computerLabel = computers.find((computer) => computer.id === project.computerId)?.displayName
            || project.computerId.replace(/^device:[^:]+:/, "");
          // A collapsed project hides its threads, so the row needs its own
          // signal for "something in here needs a look" — the same attn/run
          // vocabulary as a thread's own state pip, aggregated up one level.
          const projectGroups = groupThreads(projectThreads);
          const projectState = projectFolderTone({
            needsYou: projectGroups.needsYou.length,
            running: projectGroups.running.length,
            expanded,
          });
          const emptyKey = projectEmptyKey({
            threadCount: projectThreads.length,
            hasQuery: query.trim().length > 0,
          });
          const selection = projectFolderSelection({
            projectId: project.id,
            selectedProjectId,
            selectedSessionId,
            threadIds: projectThreads.map((item) => item.session.id),
          });
          return (
          <section key={project.id} className={`project-folder${selection ? ` ${selection}` : ""}${project.archivedAt ? " archived" : ""}${expanded ? " expanded" : " collapsed"}`}>
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
                className="project-folder-toggle"
                aria-label={t(expanded ? "project.collapse" : "project.expand", { project: project.name })}
                aria-expanded={expanded}
                onClick={() => applyExpansion(toggleProjectExpansion(expansion, project))}
              >
                <ChevronDownIcon size={ICON.sm} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                className="project-folder-select"
                aria-current={selection === "selected" ? "page" : undefined}
                tooltip={`${project.name} · ${t("project.member_count", { count: project.members.length })} · ${computerLabel}`}
                aria-label={project.name}
                onClick={() => {
                  // Selecting opens the folder, but only as a normal explicit
                  // choice — the chevron still collapses it afterwards.
                  applyExpansion(expandProject(expansion, project.id));
                  onSelectProject(project.id);
                }}
              >
                <span className="project-folder-icon">
                  <WorkspaceFolder size={ICON.sm} aria-hidden="true" />
                  {projectState ? (
                    <StateMark
                      tone={projectState === "run" ? "live" : "warn"}
                      className="project-folder-pip"
                    />
                  ) : null}
                </span>
                <span className="project-folder-name">{project.name}</span>
                {project.archivedAt ? <small>{t("project.archived")}</small> : null}
                <span className="project-folder-count tnum">{projectThreads.length}</span>
              </Button>
            </div>
            {expanded && (projectThreads.length > 0 || emptyKey) ? <div className="project-folder-threads">
                {renderProjectThreads(projectThreads)}
                {emptyKey ? <p className="project-folder-empty">{t(emptyKey)}</p> : null}
              </div> : null}
          </section>
        )}) : renderThreads(hierarchy.unclassified)}
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
      <div
        className="thread-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("thread.resize_label")}
        aria-valuenow={width}
        aria-valuemin={THREAD_LIST_WIDTH_MIN}
        aria-valuemax={THREAD_LIST_WIDTH_MAX}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKeyboard}
      />
    </aside>
  );
}
