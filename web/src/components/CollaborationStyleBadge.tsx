import { useTranslation } from "react-i18next";
import type { CollaborationStyle } from "../types";
import { effectiveStyle } from "../lib/collaborationStyle";
import { ActionRoute, ActionHandoff, MarkLead } from "./icons";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

// Shape and words carry meaning; color is only a secondary cue.
export function CollaborationStyleIcon({ style, className }: { style: CollaborationStyle; className?: string }) {
  const Icon = style === "pipeline" ? ActionHandoff : style === "lead_led" ? MarkLead : ActionRoute;
  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}

export function CollaborationStyleBadge({ style, label, className }: {
  style?: CollaborationStyle; label?: string; className?: string;
}) {
  const { t } = useTranslation();
  const resolved = effectiveStyle(undefined, style);
  return <Badge variant="neutral" className={cn("collab-style-badge", className)} data-style={resolved}
    title={t(`collab_style.${resolved}_hint`)}>
    <CollaborationStyleIcon style={resolved} />
    <span>{label ?? t(`collab_style.${resolved}`)}</span>
  </Badge>;
}
