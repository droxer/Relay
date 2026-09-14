import { useCallback, useEffect, useState } from "react";
import { clampSidenavWidth, SIDENAV_WIDTH_DEFAULT } from "../lib/sidenav";
import { clampSpaceWidth, SPACE_WIDTH_DEFAULT } from "../lib/threadSpace";
import { clampThreadListWidth, THREAD_LIST_WIDTH_DEFAULT } from "../lib/threadList";
import {
  readSidenavWidth,
  readThreadListWidth,
  readThreadSpaceWidth,
  writeSidenavWidth,
  writeThreadListWidth,
  writeThreadSpaceWidth,
} from "../lib/appStorage";

/**
 * The shell's draggable geometry: how wide the side rail, the thread rail, and
 * the thread space panel are, and whether the rail is expanded.
 *
 * Three panels, one rule each time — clamp, set, and persist only on commit —
 * which is why they belong together rather than as three near-identical
 * handlers in the root component. Dragging updates state on every frame; only
 * the pointer-up writes to storage, so a drag does not produce a hundred
 * writes.
 */
export interface PanelLayout {
  sidenavExpanded: boolean;
  sidenavWidth: number;
  threadListWidth: number;
  spaceWidth: number;
  setSidenavExpanded: (expanded: boolean) => void;
  resizeSidenav: (width: number, commit: boolean) => void;
  resizeThreadList: (width: number, commit: boolean) => void;
  resizeSpace: (width: number, commit: boolean) => void;
}

export function usePanelLayout(mounted: boolean): PanelLayout {
  const [sidenavExpanded, setSidenavExpandedState] = useState(false);
  const [sidenavWidth, setSidenavWidth] = useState(SIDENAV_WIDTH_DEFAULT);
  const [threadListWidth, setThreadListWidth] = useState(THREAD_LIST_WIDTH_DEFAULT);
  const [spaceWidth, setSpaceWidth] = useState(SPACE_WIDTH_DEFAULT);

  useEffect(() => {
    // Read after mount, not in the initializer: the export is prerendered, so
    // touching localStorage during the first render mismatches hydration.
    if (!mounted) return;
    setSidenavWidth(clampSidenavWidth(readSidenavWidth() ?? SIDENAV_WIDTH_DEFAULT));
    setThreadListWidth(clampThreadListWidth(readThreadListWidth() ?? THREAD_LIST_WIDTH_DEFAULT));
    setSpaceWidth(clampSpaceWidth(readThreadSpaceWidth() ?? SPACE_WIDTH_DEFAULT));
  }, [mounted]);

  /* Collapse state is per-visit, not persisted: every session opens on the
     collapsed rail. The WIDTH is still remembered (below) — that is the one
     thing a drag makes expensive to redo, while expanding is one click. */
  const setSidenavExpanded = useCallback((expanded: boolean) => {
    setSidenavExpandedState(expanded);
  }, []);

  const resizeSidenav = useCallback((width: number, commit: boolean) => {
    const clamped = clampSidenavWidth(width);
    setSidenavWidth(clamped);
    if (commit) writeSidenavWidth(clamped);
  }, []);

  const resizeThreadList = useCallback((width: number, commit: boolean) => {
    const clamped = clampThreadListWidth(width);
    setThreadListWidth(clamped);
    if (commit) writeThreadListWidth(clamped);
  }, []);

  const resizeSpace = useCallback((width: number, commit: boolean) => {
    const clamped = clampSpaceWidth(width);
    setSpaceWidth(clamped);
    if (commit) writeThreadSpaceWidth(clamped);
  }, []);

  return {
    sidenavExpanded,
    sidenavWidth,
    threadListWidth,
    spaceWidth,
    setSidenavExpanded,
    resizeSidenav,
    resizeThreadList,
    resizeSpace,
  };
}
