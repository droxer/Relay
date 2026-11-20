"use client";

import { createContext, useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import {
  clampThreadListWidth,
  maxThreadListWidth,
  THREAD_LIST_WIDTH_DEFAULT,
  THREAD_LIST_WIDTH_MAX,
  THREAD_LIST_WIDTH_MIN,
} from "@/lib/threadList";
import { viewportWidth } from "@/lib/shellMetrics";

/**
 * The list rail's one width, shared by every list-beside-detail surface — the
 * thread rail and the agent, team, and skill rosters. They are one object
 * (the rail row grammar in shell.css), so they take one width: the detail
 * pane's left edge stays put moving between them, and a drag on any of them
 * is remembered for all (`relay-web.threadListWidth`, via usePanelLayout).
 *
 * The thread rail gets the width as props through AppShell's own tree; the
 * rosters sit behind WorkRoutePage, which knows nothing about layout, so they
 * read it here rather than having it drilled through every route.
 */
export interface ListRailWidth {
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
}

export const ListRailWidthContext = createContext<ListRailWidth | null>(null);

/**
 * The drag handle over a roster rail's right edge. Renders nothing outside
 * the shell (no provider); the roster sheets hide it wherever the roster
 * stacks above its detail pane and there is no edge to drag.
 */
export function ListRailResizeHandle() {
  const { t } = useTranslation();
  const rail = useContext(ListRailWidthContext);
  const width = rail?.width ?? THREAD_LIST_WIDTH_DEFAULT;
  // No chat column beside a roster: only the viewport cap bounds it — the
  // same 26vw the rendered track applies, so the handle cannot outrun it.
  const ceiling = useCallback(() => maxThreadListWidth(width, null, viewportWidth()), [width]);
  if (!rail) return null;
  return (
    <ResizeHandle
      className="list-rail-resize"
      label={t("thread.resize_label")}
      width={width}
      min={THREAD_LIST_WIDTH_MIN}
      max={THREAD_LIST_WIDTH_MAX}
      defaultWidth={THREAD_LIST_WIDTH_DEFAULT}
      grows="inline-end"
      clamp={clampThreadListWidth}
      ceiling={ceiling}
      onResize={rail.onResize}
      onResizeActive={rail.onResizeActive}
    />
  );
}
