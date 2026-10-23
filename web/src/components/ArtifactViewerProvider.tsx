"use client";

import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { RelayArtifact } from "relay-core";

/* The drawer (and the code, PDF, and markdown viewers behind it) is fetched
   the first time an artifact is opened, never with the app: most sessions
   open none. Once mounted it stays, so closing keeps its exit animation. */
const ArtifactsDrawer = lazy(() => import("./artifact/ArtifactsDrawer").then((m) => ({ default: m.ArtifactsDrawer })));

interface ArtifactTarget {
  artifact: RelayArtifact;
  sessionId: string;
  allArtifacts: RelayArtifact[];
  /** Drawer stack layer — 1 when opened over another drawer (e.g. TaskDrawer). */
  layer?: number;
}

interface ArtifactViewerContextValue {
  open: (artifact: RelayArtifact, sessionId: string, allArtifacts?: RelayArtifact[], layer?: number) => void;
}

const ArtifactViewerContext = createContext<ArtifactViewerContextValue | null>(null);

export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ArtifactTarget | null>(null);
  const [drawerMounted, setDrawerMounted] = useState(false);

  const open = useCallback(
    (artifact: RelayArtifact, sessionId: string, allArtifacts?: RelayArtifact[], layer?: number) => {
      setDrawerMounted(true);
      setTarget({ artifact, sessionId, allArtifacts: allArtifacts ?? [artifact], layer });
    },
    [],
  );
  const close = useCallback(() => setTarget(null), []);

  const value = useMemo<ArtifactViewerContextValue>(() => ({ open }), [open]);

  return (
    <ArtifactViewerContext.Provider value={value}>
      {children}
      {drawerMounted ? (
        <Suspense fallback={null}>
          <ArtifactsDrawer
            open={target !== null}
            onClose={close}
            artifacts={target?.allArtifacts ?? []}
            sessionId={target?.sessionId ?? ""}
            initialArtifactId={target?.artifact.id}
            layer={target?.layer ?? 0}
          />
        </Suspense>
      ) : null}
    </ArtifactViewerContext.Provider>
  );
}

export function useArtifactViewer(): ArtifactViewerContextValue {
  const ctx = useContext(ArtifactViewerContext);
  if (!ctx) {
    throw new Error("useArtifactViewer must be used within an ArtifactViewerProvider");
  }
  return ctx;
}
