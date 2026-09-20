"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { artifactRenderMode } from "../../lib/artifactPreview";
import {
  clampSpaceWidth,
  defaultSpaceTab,
  isThreadSpaceEmpty,
  maxSpaceWidth,
  resolveSelectedSpaceItem,
  resolveSpaceTab,
  SPACE_WIDTH_DEFAULT,
  SPACE_WIDTH_MAX,
  SPACE_WIDTH_MIN,
  type SpaceItem,
  type SpaceTab,
} from "../../lib/threadSpace";
import { ArtifactBody } from "../artifact/ArtifactBody";
import { ArtifactPreviewHeader } from "../artifact/ArtifactPreviewHeader";
import type { ArtifactView } from "../artifact/ArtifactViewToggle";
import { ThreadSpaceFiles } from "./ThreadSpaceFiles";
import { ThreadSpaceList } from "./ThreadSpaceList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogPortal } from "@/components/ui/dialog";
import {
  ICON,
  ThreadSpaceToggle,
  WorkspaceFolder,
} from "../icons";
import { Button } from "@/components/ui/button";
import { OverlayCloseButton } from "@/components/ui/OverlayCloseButton";
import { useUrlSearchState } from "@/hooks/useUrlSearchState";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useChatColumnResize } from "@/hooks/useChatColumnResize";
import { SPACE_OVERLAY_QUERY } from "@/lib/breakpoints";
import { chatColumnWidth, viewportWidth } from "@/lib/shellMetrics";
import { ResizeHandle } from "@/components/ui/ResizeHandle";

const SPACE_TABS: readonly SpaceTab[] = ["project", "thread"];

export function ThreadSpacePanel({
  sessionId,
  projectId,
  items,
  showProducer,
  selectedArtifactId,
  onSelectArtifact,
  onClose,
  width,
  onResize,
  onResizeActive,
}: {
  sessionId: string;
  /** The project this thread belongs to, when it has one: its workspace is the
   *  shared record the thread contributes to, so the panel leads with it. */
  projectId?: string | null;
  items: SpaceItem[];
  showProducer: boolean;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  onClose: () => void;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const selected = resolveSelectedSpaceItem(items, selectedArtifactId);
  const isOverlay = useMediaQuery(SPACE_OVERLAY_QUERY);
  /* Modal only where the panel actually covers the viewport — the same query
     responsive.css uses to make it `fixed`, so the two cannot drift. Above
     that width the panel is a real sibling in the chat grid — no scrim, no
     portal — so the primitive is asked for `trap-focus` rather than a full
     modal, and the popup renders in place instead of through a Portal.
     Wrapping a column in a dialog would announce one that is not there. */

  // Each artifact opens on its rendered reading; the choice is per-artifact,
  // so selecting another one starts from preview again rather than carrying a
  // source view onto a file the user has not looked at yet.
  const [view, setView] = useState<ArtifactView>("preview");

  /* The tab lives in the URL beside `?space=1&artifact=`, so the whole panel
     is one addressable state: a project workspace view can be linked, not
     only an open artifact. It stays per-thread all the same — switching
     threads re-derives the default rather than carrying a solo thread's
     own-files choice onto a project thread. */
  /* Stable identities: the reset effect below depends on the setter, and an
     inline parse/serialize would rebuild it every render into a loop. */
  const parseTab = useCallback(
    (value: string | null): SpaceTab =>
      value === "project" || value === "thread" ? value : defaultSpaceTab(projectId),
    [projectId],
  );
  const serializeTab = useCallback(
    (value: SpaceTab): string | null => (value === "project" ? value : null),
    [],
  );
  const [tab, setTab] = useUrlSearchState<SpaceTab>(
    "spaceTab",
    defaultSpaceTab(projectId),
    parseTab,
    serializeTab,
  );
  /* Re-derive the default when the reader moves to ANOTHER thread — never on
     arrival. Resetting on mount too would overwrite the tab a pasted link
     just asked for, which is the whole reason the tab is in the URL. */
  const threadKey = `${sessionId}\u0000${projectId ?? ""}`;
  const lastThreadKey = useRef(threadKey);
  useEffect(() => {
    if (lastThreadKey.current === threadKey) return;
    lastThreadKey.current = threadKey;
    setTab(defaultSpaceTab(projectId));
  }, [threadKey, projectId, setTab]);
  const selectedId = selected?.artifact.id ?? null;
  useEffect(() => setView("preview"), [selectedId]);
  const renderMode = selected ? artifactRenderMode(selected.artifact) : "none";
  /* The project tab's open FILE, held here rather than inside the browser:
     when a file is open the panel header steps aside and the file's own header
     becomes the panel's only chrome row, which the header cannot decide from
     state its grandchild owns. The directory path stays inside the browser —
     the header does not care which folder you are in. */
  const [projectFile, setProjectFile] = useState("");
  useEffect(() => setProjectFile(""), [projectId, sessionId]);
  const activeTab = resolveSpaceTab(tab, projectId, Boolean(selected));
  /* One chrome row, not two. A file's header carries the back control, the
     name, its actions and the close button, so a second row above it stating
     the panel's name would be 64px spent restating where you already are —
     and it is what pushed the panel's content a whole header out of line with
     the transcript beside it. The tab strip goes with it: drilled into a file,
     the Project / This thread switcher has nothing to switch. */
  const fileOpen = Boolean(selected) || (activeTab === "project" && Boolean(projectFile));
  const showTabs = Boolean(projectId) && !fileOpen;
  // The panel is named for what it holds: a project thread's panel is the
  // project's shared workspace, a solo thread's is just its own files. Same
  // word as the header pill that opened it.
  const panelName = projectId ? t("space.title_project") : t("space.title");

  /* Ceiling measured against the live transcript — read once per gesture and
     once per key press, never per pointer move. */
  const spaceCeiling = useCallback(() => maxSpaceWidth(width, chatColumnWidth(), viewportWidth()), [width]);

  // Anything that narrows the transcript while the panel is open can push it
  // under its floor — a narrowed window, but equally an expanding side rail;
  // give the room back rather than leaving the conversation squeezed. Only
  // ever shrinks — maxSpaceWidth is a ceiling, not a target.
  useChatColumnResize(useCallback(() => {
    const max = maxSpaceWidth(width, chatColumnWidth(), viewportWidth());
    // Not committed: a temporary squeeze shouldn't overwrite the width the
    // user actually chose.
    if (width > max) onResize(max, false);
  }, [onResize, width]), !isOverlay);

  const panel = (
    <>
      <ResizeHandle
        className="thread-space-resize"
        label={t("space.resize_label")}
        width={width}
        min={SPACE_WIDTH_MIN}
        max={SPACE_WIDTH_MAX}
        defaultWidth={SPACE_WIDTH_DEFAULT}
        /* The panel sits RIGHT of the transcript, so the gesture and the arrow
           keys both invert: dragging left is what grows it. */
        grows="inline-start"
        clamp={clampSpaceWidth}
        ceiling={spaceCeiling}
        onResize={onResize}
        onResizeActive={onResizeActive}
      />
      {/* The Tabs root IS `.thread-space-inner`: that element owns the grid
          rows the header, tab strip, and body sit in, so a wrapper of its own
          would break the layout. The tab strip only exists on a project thread
          with nothing selected, which is why the body below falls back to a
          plain div — a lone `role="tabpanel"` with no tablist owning it is
          worse than no tab semantics at all. */}
      <Tabs
        className="thread-space-inner"
        value={activeTab}
        onValueChange={(value) => setTab(value as SpaceTab)}
      >
        {/* The panel's name and the way out, while you are looking at the
            LIST. It used to swap its title for a `← Files` button whenever a
            file was open, seating a back control and the close control side by
            side in one row where both read as "get me out of here". A file's
            header takes over the row instead, and puts the whole filename and
            its actions between those two controls. */}
        {fileOpen ? null : (
          <header className="thread-space-header">
            <h2 className="thread-space-title">{panelName}</h2>
            <OverlayCloseButton label={t("sheet.close")} onClick={onClose} />
          </header>
        )}
        {showTabs ? (
          <TabsList className="thread-space-tabs" aria-label={t("space.tabs_label")}>
            {SPACE_TABS.map((name) => (
              <TabsTrigger
                key={name}
                value={name}
                className={`thread-space-tab${activeTab === name ? " is-active" : ""}`}
              >
                {name === "project" ? t("space.tab_project") : t("space.tab_thread")}
                {name === "thread" && items.length ? (
                  <span className="thread-space-tab-count tnum">{items.length}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : null}
        <SpaceBody className="thread-space-body" showTabs={showTabs} value={activeTab}>
          {activeTab === "project" && projectId ? (
            /* Keyed by project: the browser holds its directory path and open
               file in local state, so without this, switching to a thread in
               another project re-requested the previous project's path against
               a workspace that has no such directory — the tab opened on an
               error. */
            <ThreadSpaceFiles
              key={projectId}
              projectId={projectId}
              selectedPath={projectFile}
              onSelectPath={setProjectFile}
              onClose={onClose}
            />
          ) : selected ? (
            <div className="thread-space-preview">
              <ArtifactPreviewHeader
                artifact={selected.artifact}
                sessionId={sessionId}
                onBack={() => onSelectArtifact(null)}
                onClose={onClose}
                /* The switch renders in the file's own header, beside its name
                   — the same row the workspace pane puts it in. A body with
                   one reading gets no switch. */
                view={renderMode === "none" ? undefined : view}
                onViewChange={renderMode === "none" ? undefined : setView}
              />
              <div className="artifact-preview-body">
                <ArtifactBody artifact={selected.artifact} sessionId={sessionId} view={view} />
              </div>
            </div>
          ) : isThreadSpaceEmpty(items) ? (
            <div className="thread-space-empty">
              <span className="thread-space-empty-mark" aria-hidden="true">
                <ThreadSpaceToggle size={ICON.lg} />
              </span>
              <p className="thread-space-empty-title">{t("space.empty_title")}</p>
              <p className="thread-space-empty-body">
                {projectId ? t("space.empty_body_project") : t("space.empty_body")}
              </p>
              {projectId ? (
                <Button type="button" size="dense" onClick={() => setTab("project")}>
                  <WorkspaceFolder size={ICON.sm} />
                  {t("space.empty_cta_files")}
                </Button>
              ) : (
                <Button type="button" variant="outline" size="dense" onClick={onClose}>
                  {t("space.empty_cta_back")}
                </Button>
              )}
            </div>
          ) : (
            <ThreadSpaceList
              items={items}
              showProducer={showProducer}
              selectedId={selectedArtifactId}
              onSelect={(artifactId) => onSelectArtifact(artifactId)}
            />
          )}
        </SpaceBody>
      </Tabs>
    </>
  );

  if (!isOverlay) {
    return (
      <aside className="thread-space-panel" aria-label={t("space.panel_label")}>
        {panel}
      </aside>
    );
  }

  /* The popup must sit inside a DialogPortal: a Base UI `Dialog.Popup` with
     no portal ancestor throws, and React unwinds to ScreenErrorBoundary — so
     the panel did not merely fail to open, it replaced the whole threads
     screen with "This screen could not load". An earlier draft left the
     portal out on purpose, reasoning that a panel already covering the
     viewport has nothing to escape; the primitive does not offer that choice.
     No backdrop for that same reason: the panel IS the full viewport at this
     width, so a scrim behind it would never be seen, and there is no outside
     left to click. Escape and the close button are the ways out. */
  return (
    <Dialog
      open
      modal="trap-focus"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPortal>
        <DialogContent
          render={<aside />}
          className="thread-space-panel"
          aria-label={t("space.panel_label")}
        >
          {panel}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/** The body is a real tab panel only while the tab strip is on screen. */
function SpaceBody({
  showTabs,
  value,
  className,
  children,
}: {
  showTabs: boolean;
  value: SpaceTab;
  className: string;
  children: ReactNode;
}) {
  if (!showTabs) return <div className={className}>{children}</div>;
  return (
    <TabsContent value={value} className={className} keepMounted>
      {children}
    </TabsContent>
  );
}
