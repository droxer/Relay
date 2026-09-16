import { useCallback, useEffect, useState } from "react";
import { readThreadListBesideSpace, writeThreadListBesideSpace } from "../lib/appStorage";
import { useUrlSearchState } from "./useUrlSearchState";

/**
 * The thread space panel — the artifact/detail surface that slides in beside
 * a transcript.
 *
 * URL-driven (`?space=1&artifact=<id>`) so the view survives a reload and can
 * be shared, which is why opening it is not a plain `setState`: the canonical
 * URL keeps `?artifact` only while the panel is open, so the two writes have
 * an order and `space=1` has to land first or the selection is dropped on the
 * way in. Keeping open/close/toggle next to that rule is the point of the
 * hook — three call sites each remembering the ordering is how it gets broken.
 *
 * The thread rail's collapse rides along because the two are one gesture:
 * opening the panel makes room by hiding the rail, closing it gives the room
 * back. Whether the list stays hidden is the user's standing choice: showing
 * it beside the panel is remembered across panels, threads, and reloads.
 */
export interface ThreadSpace {
  open: boolean;
  artifactId: string | null;
  /** True when the rail is collapsed to make room for the panel. */
  threadListHidden: boolean;
  selectArtifact: (artifactId: string | null) => void;
  setThreadListHidden: (hidden: boolean) => void;
  openSpace: (artifactId?: string | null) => void;
  closeSpace: () => void;
  toggleSpace: () => void;
}

export function useThreadSpace(activeSessionId: string | undefined): ThreadSpace {
  const [open, setOpen] = useUrlSearchState<boolean>(
    "space",
    false,
    (value) => value === "1",
    (value) => (value ? "1" : null),
  );
  const [artifactId, setArtifactId] = useUrlSearchState<string | null>(
    "artifact",
    null,
    (value) => value,
    (value) => value,
  );
  const [threadListHidden, setThreadListHiddenState] = useState(false);

  // A header toggle is the user stating where they want the list, so it is
  // the one path that writes; open/close/session resets only apply it.
  const setThreadListHidden = useCallback((hidden: boolean) => {
    setThreadListHiddenState(hidden);
    writeThreadListBesideSpace(!hidden);
  }, []);

  const openSpace = useCallback((nextArtifactId: string | null = null) => {
    if (!activeSessionId) return;
    setThreadListHiddenState(!readThreadListBesideSpace());
    // space=1 must land first: the canonical URL keeps ?artifact only while
    // the panel is open, so writing the selection first would drop it.
    setOpen(true);
    setArtifactId(nextArtifactId);
  }, [activeSessionId, setArtifactId, setOpen]);

  const closeSpace = useCallback(() => {
    setOpen(false);
    setArtifactId(null);
    setThreadListHiddenState(false);
  }, [setArtifactId, setOpen]);

  const toggleSpace = useCallback(() => {
    if (!activeSessionId) return;
    if (open) closeSpace();
    else openSpace();
  }, [activeSessionId, closeSpace, open, openSpace]);

  useEffect(() => {
    // Session switches navigate to a new path, which drops the space/artifact
    // search params; only the local rail collapse needs resetting. It also runs
    // on mount, where a reload may land with ?space=1 already open — so apply
    // the remembered choice rather than always revealing the list. Deferred to
    // an effect for the same prerender/hydration reason as usePanelLayout.
    setThreadListHiddenState(!readThreadListBesideSpace());
  }, [activeSessionId]);

  return {
    open,
    artifactId,
    threadListHidden,
    selectArtifact: setArtifactId,
    setThreadListHidden,
    openSpace,
    closeSpace,
    toggleSpace,
  };
}
