"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OverlayCloseButton } from "@/components/ui/OverlayCloseButton";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { readDrawerWidth, writeDrawerWidth } from "@/lib/appStorage";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";

/** Named panel widths — call sites pick a role, not a pixel count, so drawer
 *  sizing stays consistent across the app. `form` for single-column edit
 *  forms, `detail` for read/inspect panels, `wide` for preview panes. `task`
 *  and `routine` are the task-board drawer's two variants (routine needs room
 *  for its schedule fields). These are only the defaults: every named-width
 *  drawer can be dragged wider and remembers the chosen width per role. */
const DRAWER_WIDTHS = {
  form: 520,
  detail: 600,
  task: 680,
  routine: 720,
  wide: 1080,
} as const;

/** The resize gesture's floor, and a cap so a drag cannot bury the page
 *  under the panel. The live ceiling (viewport) is measured at gesture
 *  start, like the shell splitters. */
const DRAWER_WIDTH_MIN = 380;
const DRAWER_WIDTH_MAX = 1600;

export type DrawerWidth = keyof typeof DRAWER_WIDTHS;

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Render the subtitle in the mono face — for ID/handle subtitles. */
  subtitleMono?: boolean;
  kicker?: ReactNode;
  /** Named width role, or an explicit pixel width for one-off layouts. */
  width?: DrawerWidth | number;
  children: ReactNode;
  closeLabel: string;
  /** Accessible name override. Defaults to `title` when it is a string. */
  ariaLabel?: string;
  /** Extra class on the scroll body — e.g. to opt into a flex-column layout
   *  so a form footer can anchor to the bottom of the panel. */
  bodyClassName?: string;
  /** Stacking order — higher = on top. Used when multiple drawers open at once. */
  layer?: number;
  /** Called once the exit animation completes and the panel has left the DOM.
   *  Lets parents defer unmounting form state until the close has fully played. */
  onClosed?: () => void;
}

/**
 * The app's side panel, on the shared Dialog primitive.
 *
 * Everything this component used to do by hand — Escape, the Tab trap,
 * autofocus, focus restore, the body scroll lock, holding the panel in the
 * DOM for its exit animation, and tracking which of several open drawers owns
 * the keyboard — now comes from base-ui. What is left here is the drawer's
 * own shape: a named width, a header with kicker/title/subtitle, and a
 * scrolling body.
 *
 * Stacking still takes a `layer`, because the z-index has to beat the sibling
 * backdrops, but the UNDERLAY treatment is no longer computed: base-ui marks
 * a popup with `data-nested-dialog-open` when a drawer opens above it, and
 * admin-v2-drawers.css recesses it from there.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  subtitleMono = false,
  kicker,
  width = "detail",
  children,
  closeLabel,
  ariaLabel,
  bodyClassName,
  layer = 0,
  onClosed,
}: DrawerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  /* Width is a role default until the user drags the edge; the dragged width
     persists per role so e.g. every task record opens at the width the user
     last chose. Read on open, not in the initializer — the portal content is
     what mounts, and storage reads during prerender would mismatch. */
  const widthRole = typeof width === "number" ? null : width;
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!open || widthRole === null) return;
    const stored = readDrawerWidth(widthRole);
    setDraggedWidth(stored === null ? null : Math.min(Math.max(stored, DRAWER_WIDTH_MIN), DRAWER_WIDTH_MAX));
  }, [open, widthRole]);
  const onResize = useCallback((next: number, commit: boolean) => {
    setDraggedWidth(next);
    if (commit && widthRole !== null) writeDrawerWidth(widthRole, next);
  }, [widthRole]);

  const resolvedWidth =
    draggedWidth ?? (typeof width === "number" ? width : DRAWER_WIDTHS[width]);
  const resolvedAriaLabel = ariaLabel ?? (typeof title === "string" ? title : undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed?.();
      }}
    >
      <DialogPortal>
        <DialogBackdrop
          className="adm-drawer-backdrop"
          style={{ zIndex: `calc(var(--z-drawer) + ${layer})` }}
        />
        <DialogViewport
          className="adm-drawer-viewport"
          style={{ zIndex: `calc(var(--z-drawer) + ${layer})` }}
        >
          <DialogContent
            ref={panelRef}
            render={<aside />}
            className="adm-drawer"
            aria-label={resolvedAriaLabel}
            aria-labelledby={resolvedAriaLabel ? undefined : titleId}
            aria-describedby={subtitle ? subtitleId : undefined}
            style={{ "--adm-drawer-w": `${resolvedWidth}px` } as React.CSSProperties}
            /* `[data-modal-initial-focus]` stays the call-site convention —
               eight drawers mark their first meaningful field with it. What
               changed is who reads it: the primitive, through this prop,
               instead of a hand-rolled trap.
               A coarse pointer keeps focus on the panel, because focusing a
               field there throws up the on-screen keyboard over the drawer
               the moment it opens. */
            initialFocus={(openType) =>
              openType === "touch"
                ? true
                : panelRef.current?.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? true
            }
          >
            {/* The left edge doubles as a splitter: the drawer sits at the
                viewport's inline-end, so it grows inline-start. Numeric
                widths are one-off layouts and stay fixed. Hidden by CSS at
                the mobile breakpoint, where the drawer takes full width.
                The ceiling mirrors the 92vw cap in .adm-drawer
                (admin-v2-drawers.css) — a wider value than the CSS cap
                would drag dead. */}
            {widthRole !== null ? (
              <ResizeHandle
                className="adm-drawer-resize"
                label={t("drawer.resize_label")}
                width={resolvedWidth}
                min={DRAWER_WIDTH_MIN}
                max={DRAWER_WIDTH_MAX}
                defaultWidth={DRAWER_WIDTHS[widthRole]}
                grows="inline-start"
                clamp={(next, limit) => Math.min(Math.max(next, DRAWER_WIDTH_MIN), Math.min(limit, DRAWER_WIDTH_MAX))}
                ceiling={() => Math.floor(window.innerWidth * 0.92)}
                onResize={onResize}
                onResizeActive={() => {}}
              />
            ) : null}
            <header className="adm-drawer-head">
              <div className="adm-drawer-head-text">
                {kicker ? <p className="adm-drawer-kicker">{kicker}</p> : null}
                <DialogTitle id={titleId} className="adm-drawer-title" render={<h2 />}>
                  {title}
                </DialogTitle>
                {subtitle ? (
                  <DialogDescription
                    id={subtitleId}
                    className={`adm-drawer-sub${subtitleMono ? " adm-drawer-sub--mono" : ""}`}
                    translate={subtitleMono ? "no" : undefined}
                    render={<p />}
                  >
                    {subtitle}
                  </DialogDescription>
                ) : null}
              </div>
              <OverlayCloseButton
                label={closeLabel}
                onClick={onClose}
                className="overlay-close"
              />
            </header>
            <div className={`adm-drawer-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
          </DialogContent>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
