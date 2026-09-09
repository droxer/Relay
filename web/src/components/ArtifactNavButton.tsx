"use client";

import { useTranslation } from "react-i18next";
import {
  ICON,
  ThreadSpaceToggle,
} from "./icons";
import { Button } from "@/components/ui/button";

/** Opens the thread's files panel. A named control, not a bare glyph, and the
 *  name is the place it lands on: a thread inside a project opens on the
 *  project's shared workspace, so the pill reads "Workspace" there and "Files"
 *  on a thread that only has its own. The count chip rides along only on the
 *  second case — on a project thread it would promise a tally of something the
 *  panel does not open on, and that tally lives on the panel's own tab instead.
 *  Below the tablet breakpoint responsive.css drops the label back to the icon,
 *  where the top bar has no room for words. */
export function ArtifactNavButton({ artifactCount, inProject, onOpenArtifacts, expanded, disabled, className }: {
  artifactCount: number;
  /** Whether this thread belongs to a project — the panel leads with the
   *  project workspace when it does. */
  inProject?: boolean;
  onOpenArtifacts: () => void;
  expanded?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = inProject ? t("space.title_project") : t("space.title");
  const toggleLabel = inProject ? t("space.toggle_project") : t("space.toggle");
  const showCount = !inProject && artifactCount > 0;

  return (
    <Button
      variant="ghost"
      size="dense"
      className={`chat-artifacts-button${className ? ` ${className}` : ""}`}
      type="button"
      aria-label={toggleLabel}
      title={toggleLabel}
      aria-expanded={expanded ?? false}
      disabled={disabled}
      onClick={onOpenArtifacts}
    >
      <ThreadSpaceToggle size={ICON.md} />
      <span className="chat-artifacts-label">{label}</span>
      {showCount ? (
        <span className="chat-artifacts-count tnum" aria-label={t("space.count_label", { count: artifactCount })}>
          {artifactCount}
        </span>
      ) : null}
    </Button>
  );
}
