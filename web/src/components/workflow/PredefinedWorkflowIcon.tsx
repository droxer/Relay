import type { CollaborationStyle } from "../../types";
import { ActionRoute, ActionHandoff, MarkLead } from "../icons";
import { cn } from "../../lib/utils";

/** A predefined Workflow's glyph. Shape and words carry meaning; color is
 *  only a secondary cue. */
export function PredefinedWorkflowIcon({ style, className }: { style: CollaborationStyle; className?: string }) {
  const Icon = style === "pipeline" ? ActionHandoff : style === "lead_led" ? MarkLead : ActionRoute;
  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}
