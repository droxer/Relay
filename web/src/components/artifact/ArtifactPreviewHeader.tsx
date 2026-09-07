import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";
import { artifactRawHref } from "../../lib/artifactPreview";
import { Button } from "@/components/ui/button";
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
}: {
  artifact: RelayArtifact;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      <span className={`artifact-kind-tag is-${artifact.kind}`}>{kindLabel}</span>
      <span className="artifact-preview-header-title">{artifact.title}</span>
      <div className="artifact-preview-actions">
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
      </div>
    </header>
  );
}
