import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";
import { Button } from "@/components/ui/button";
import { ICON, StreamAttachment } from "./icons";
import { useArtifactViewer } from "./ArtifactViewerProvider";

export function AttachmentMarker({
  artifacts,
  sessionId,
  onOpenArtifact,
}: {
  artifacts: RelayArtifact[];
  sessionId: string;
  onOpenArtifact?: (artifact: RelayArtifact) => void;
}) {
  const { t } = useTranslation();
  const viewer = useArtifactViewer();
  const first = artifacts[0];
  if (!first) return null;

  const label =
    artifacts.length === 1
      ? first.title
      : t("artifact.inline_files", { count: artifacts.length });

  return (
    <Button
      variant="ghost"
      type="button"
      className="attachment-marker"
      onClick={() => {
        if (onOpenArtifact) onOpenArtifact(first);
        else viewer.open(first, sessionId, artifacts);
      }}
      aria-label={t("artifact.view_named", { title: label })}
    >
      <StreamAttachment size={ICON.sm} aria-hidden="true" />
      <span className="attachment-marker-label">{label}</span>
    </Button>
  );
}
