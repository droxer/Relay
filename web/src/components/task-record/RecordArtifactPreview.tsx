"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArtifactBody } from "../artifact/ArtifactBody";
import { ArtifactPreviewHeader } from "../artifact/ArtifactPreviewHeader";
import type { ArtifactView } from "../artifact/ArtifactViewToggle";
import { artifactRenderMode } from "../../lib/artifactPreview";
import type { ArtifactIndexItem } from "../../types";

/** The picked file of a task's Files tab, read in place: the artifact
 *  drawer's own header and body, so a file has one set of controls wherever
 *  it opens. Loaded on first use — the code, PDF, and Markdown viewers behind
 *  the body stay out of the record until a file is shown. */
export function RecordArtifactPreview({ artifact, onBack }: {
  artifact: ArtifactIndexItem;
  /** Back to the list, where the pane is too narrow to show both. */
  onBack: () => void;
}) {
  const { t } = useTranslation();
  /* Each file opens on its rendered reading: the list keys this pane by
     artifact, so a new pick starts here rather than in the last one's view. */
  const [view, setView] = useState<ArtifactView>("preview");
  const renderMode = artifactRenderMode(artifact);

  return (
    <section className="record-artifacts-preview artifact-preview-pane" aria-label={t("artifact.preview_label")}>
      <ArtifactPreviewHeader
        artifact={artifact}
        sessionId={artifact.sessionId}
        onBack={onBack}
        /* A body with one reading gets no switch. */
        view={renderMode === "none" ? undefined : view}
        onViewChange={renderMode === "none" ? undefined : setView}
      />
      <div className="artifact-preview-body">
        <ArtifactBody artifact={artifact} sessionId={artifact.sessionId} view={view} />
      </div>
    </section>
  );
}
