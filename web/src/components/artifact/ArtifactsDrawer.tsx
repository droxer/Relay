import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";
import { Drawer } from "@/components/ui/Drawer";
import { ArtifactBody } from "./ArtifactBody";
import { ArtifactIndexStrip } from "./ArtifactIndexStrip";
import { ArtifactPreviewHeader } from "./ArtifactPreviewHeader";
import type { ArtifactView } from "./ArtifactViewToggle";
import { artifactRenderMode } from "../../lib/artifactPreview";
import { ArtifactsEmpty } from "./ArtifactsEmpty";
import { OVERLAY_TAKEOVER_QUERY } from "../../lib/breakpoints";

function resolveSessionId(artifact: RelayArtifact, fallback: string): string {
  return (artifact as unknown as { sessionId?: string }).sessionId ?? fallback;
}

export function ArtifactsDrawer({
  open,
  onClose,
  artifacts,
  sessionId,
  initialArtifactId,
  layer = 0,
}: {
  open: boolean;
  onClose: () => void;
  artifacts: RelayArtifact[];
  sessionId: string;
  initialArtifactId?: string;
  layer?: number;
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stripExpanded, setStripExpanded] = useState(false);
  /* Narrow screens lay the list out in flow above the preview; wide ones
     slide it over the preview, so there a pick should put it away again. */
  const [listInFlow, setListInFlow] = useState(false);
  const [view, setView] = useState<ArtifactView>("preview");

  const artifactsRef = useRef(artifacts);
  artifactsRef.current = artifacts;

  // Sync selection when the drawer opens or the initial artifact changes.
  useEffect(() => {
    if (!open) return;
    setSelectedId(initialArtifactId ?? artifactsRef.current[0]?.id ?? null);

    const mq = window.matchMedia(OVERLAY_TAKEOVER_QUERY);
    setStripExpanded(mq.matches);
    setListInFlow(mq.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setStripExpanded(event.matches);
      setListInFlow(event.matches);
    };
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, [open, initialArtifactId]);

  const selectedArtifact = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? artifacts[0] ?? null,
    [artifacts, selectedId],
  );

  // Each file opens on its rendered reading, as in the thread space panel.
  useEffect(() => setView("preview"), [selectedArtifact?.id]);
  const renderMode = selectedArtifact ? artifactRenderMode(selectedArtifact) : "none";

  function selectArtifact(id: string): void {
    setSelectedId(id);
    if (!listInFlow) setStripExpanded(false);
  }

  const effectiveSessionId = selectedArtifact
    ? resolveSessionId(selectedArtifact, sessionId)
    : sessionId;

  const subtitle = t("artifact.drawer_subtitle", { count: artifacts.length });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      layer={layer}
      width="wide"
      closeLabel={t("drawer.close")}
      title={t("artifact.drawer_title")}
      subtitle={subtitle}
      bodyClassName="artifact-library-drawer-body"
    >
      <div className={`artifact-library-shell${stripExpanded ? " strip-expanded" : ""}`}>
        {artifacts.length === 0 ? (
          /* Empty library: no strip, no preview chrome — the ghost-ledger
             empty state spans the whole shell (see .artifact-library-shell >
             .artifacts-empty in artifact.css). */
          <ArtifactsEmpty title={t("artifact.drawer_empty")} />
        ) : (
          <>
            <ArtifactIndexStrip
              artifacts={artifacts}
              selectedId={selectedId}
              onSelect={selectArtifact}
              expanded={stripExpanded}
              onExpandedChange={setStripExpanded}
            />

            <section className="artifact-preview-pane" aria-label={t("artifact.preview_label")}>
              {selectedArtifact ? (
                <>
                  <ArtifactPreviewHeader
                    artifact={selectedArtifact}
                    sessionId={effectiveSessionId}
                    /* Same switch, same rule as the thread space panel: a
                       body with one reading gets no switch. */
                    view={renderMode === "none" ? undefined : view}
                    onViewChange={renderMode === "none" ? undefined : setView}
                  />
                  <div className="artifact-preview-body">
                    <ArtifactBody artifact={selectedArtifact} sessionId={effectiveSessionId} view={view} />
                  </div>
                </>
              ) : (
                <p className="artifact-preview-status">{t("artifact.preview_placeholder")}</p>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}
