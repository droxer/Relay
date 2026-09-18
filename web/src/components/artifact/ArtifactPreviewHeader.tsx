import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";
import { artifactRawHref } from "../../lib/artifactPreview";
import { ArtifactViewToggle, type ArtifactView } from "./ArtifactViewToggle";
import { FilePaneBack } from "../workspace/FilePaneBack";
import { Button } from "@/components/ui/button";
import { OverlayCloseButton } from "@/components/ui/OverlayCloseButton";
import { useDialogs } from "@/components/ui/DialogProvider";

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "artifact";
}

const TEXT_KINDS: ReadonlySet<RelayArtifact["kind"]> = new Set([
  "diff",
  "review",
  "summary",
  "agent_output",
  "command_log",
  "test_output",
  "plan",
]);

export function ArtifactPreviewHeader({
  artifact,
  sessionId,
  view,
  onViewChange,
  onBack,
  onClose,
}: {
  artifact: RelayArtifact;
  sessionId: string;
  /** The reading on screen, when the caller offers a switch. Passed together
   *  with `onViewChange` or not at all — a header with no switch is a header
   *  for a body that has only one reading. */
  view?: ArtifactView;
  onViewChange?: (view: ArtifactView) => void;
  /** Returns to the list this artifact was picked from. Omitted where the list
   *  is still on screen beside the preview (the artifact drawer's index strip),
   *  which has nothing to go back to. */
  onBack?: () => void;
  /** Dismisses the surface this header sits in. Passed where this row IS that
   *  surface's only chrome (the thread space panel); omitted where the
   *  container has a header of its own (the artifact drawer). */
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* A workspace file's kind tag reads "File" next to a name ending in `.md` —
   * the chip earns its place for a plan, a diff or a review, which the name
   * alone does not tell you, and is pure noise for a file. */
  const showKind = artifact.kind !== "workspace_file";
  const kindLabel = t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind });
  const rawHref = artifactRawHref(sessionId, artifact.id);
  const canCopy = TEXT_KINDS.has(artifact.kind);

  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    try {
      const response = await fetch(rawHref);
      if (!response.ok) throw new Error(response.statusText);
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable (permissions, non-secure context) — surface it
      // and point at the manual fallback instead of silently doing nothing.
      announce({
        message: t("artifact.copy_failed", {
          defaultValue: "Couldn't copy the artifact. Download it or open the raw file and copy it manually.",
        }),
        tone: "error",
      });
    }
  }, [rawHref, announce, t]);

  return (
    <header className="artifact-preview-header">
      {onBack ? <FilePaneBack onClick={onBack} /> : null}
      {showKind ? <span className={`artifact-kind-tag is-${artifact.kind}`}>{kindLabel}</span> : null}
      <span className="artifact-preview-header-title">{artifact.title}</span>
      {/* The switch belongs to the FILE, not to the panel around it: it used to
          sit in the panel header a row above, so the same control lived in two
          different places depending on which tab you reached the file
          through. Same row, same order as the workspace pane. */}
      <div className="artifact-preview-actions">
        {view && onViewChange ? <ArtifactViewToggle view={view} onChange={onViewChange} /> : null}
        {canCopy ? (
          <Button variant="ghost"
            type="button"
            className="artifact-preview-action-btn"
            onClick={handleCopy}
            aria-label={copied ? t("artifact.copied") : t("artifact.action_copy")}
          >
            {copied ? t("artifact.copied") : t("artifact.action_copy")}
          </Button>
        ) : null}
        <a
          className="artifact-preview-action-btn"
          href={rawHref}
          download={sanitizeFilename(artifact.title)}
          aria-label={t("artifact.action_download")}
        >
          {t("artifact.action_download")}
        </a>
        {onClose ? <OverlayCloseButton label={t("sheet.close")} onClick={onClose} /> : null}
      </div>
    </header>
  );
}
