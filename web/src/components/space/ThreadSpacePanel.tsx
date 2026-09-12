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
import { ArtifactViewToggle, type ArtifactView } from "../artifact/ArtifactViewToggle";
import { ThreadSpaceFiles } from "./ThreadSpaceFiles";
import { ThreadSpaceList } from "./ThreadSpaceList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  ICON,
  NavBack,
  ThreadSpaceToggle,
  WorkspaceFolder,
} from "../icons";
import { Button } from "@/components/ui/button";
import { OverlayCloseButton } from "@/components/ui/OverlayCloseButton";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useChatColumnResize } from "@/hooks/useChatColumnResize";
import { SPACE_OVERLAY_QUERY } from "@/lib/breakpoints";


const KEYBOARD_RESIZE_STEP = 16;

/** The chat column, measured to work out how much width the panel may still
 *  take. Read straight from the DOM rather than threaded down as a prop: the
 *  grid — not React — owns the column's real width. */
function transcriptWidth(): number | null {
  if (typeof document === "undefined") return null;
  const chat = document.getElementById("chat-panel");
  return chat ? chat.getBoundingClientRect().width : null;
}

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

  // The tab is per-thread: switching threads re-derives the default rather
  // than carrying a solo thread's own-files choice onto a project thread.
  const [tab, setTab] = useState<SpaceTab>(() => defaultSpaceTab(projectId));
  useEffect(() => setTab(defaultSpaceTab(projectId)), [projectId, sessionId]);
  const selectedId = selected?.artifact.id ?? null;
  useEffect(() => setView("preview"), [selectedId]);
  const renderMode = selected ? artifactRenderMode(selected.artifact) : "none";
  const activeTab = resolveSpaceTab(tab, projectId, Boolean(selected));
  const showTabs = Boolean(projectId) && !selected;
  // The panel is named for what it holds: a project thread's panel is the
  // project's shared workspace, a solo thread's is just its own files. Same
  // word as the header pill that opened it.
  const panelName = projectId ? t("space.title_project") : t("space.title");

  // A drag registers listeners outside React; this releases them if the panel
  // unmounts (or the thread changes) mid-gesture, which would otherwise leak
  // the listeners and strand the shell in its resizing state.
  const releaseDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseDragRef.current?.(), []);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    // Ceiling fixed at gesture start: the transcript shrinks as the drag
    // proceeds, so re-measuring per move would let the panel walk past it.
    const max = maxSpaceWidth(width, transcriptWidth());
    handle.setPointerCapture(event.pointerId);
    onResizeActive(true);

    const widthAt = (clientX: number) => clampSpaceWidth(width + (startX - clientX), max);
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
    // pointerup — without this the shell keeps `data-space-resizing` forever.
    const cancel = () => finish(null);

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    releaseDragRef.current = () => finish(null);
  }, [onResize, onResizeActive, width]);

  const resizeByKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const max = maxSpaceWidth(width, transcriptWidth());
    if (event.key === "Home") {
      event.preventDefault();
      onResize(clampSpaceWidth(SPACE_WIDTH_DEFAULT, max), true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    onResize(clampSpaceWidth(width + delta, max), true);
  }, [onResize, width]);

  // Anything that narrows the transcript while the panel is open can push it
  // under its floor — a narrowed window, but equally an expanding side rail;
  // give the room back rather than leaving the conversation squeezed. Only
  // ever shrinks — maxSpaceWidth is a ceiling, not a target.
  useChatColumnResize(useCallback(() => {
    const max = maxSpaceWidth(width, transcriptWidth());
    // Not committed: a temporary squeeze shouldn't overwrite the width the
    // user actually chose.
    if (width > max) onResize(max, false);
  }, [onResize, width]), !isOverlay);

  const panel = (
    <>
      <div
        className="thread-space-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("space.resize_label")}
        aria-valuenow={width}
        aria-valuemin={SPACE_WIDTH_MIN}
        aria-valuemax={SPACE_WIDTH_MAX}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKeyboard}
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
        <header className="thread-space-header">
          {selected ? (
            <Button
              variant="ghost"
              type="button"
              className="thread-space-back"
              onClick={() => onSelectArtifact(null)}
            >
              <NavBack size={ICON.sm} />
              <span>{panelName}</span>
            </Button>
          ) : (
            <h2 className="thread-space-title">{panelName}</h2>
          )}
          {selected && renderMode !== "none" ? (
            <ArtifactViewToggle view={view} onChange={setView} className="thread-space-view-toggle" />
          ) : null}
          <OverlayCloseButton label={t("sheet.close")} onClick={onClose} />
        </header>
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
            <ThreadSpaceFiles projectId={projectId} />
          ) : selected ? (
            <div className="thread-space-preview">
              <ArtifactPreviewHeader artifact={selected.artifact} sessionId={sessionId} />
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

  return (
    <Dialog
      open
      modal="trap-focus"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        render={<aside />}
        className="thread-space-panel"
        aria-label={t("space.panel_label")}
      >
        {panel}
      </DialogContent>
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
