import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import type { AgentName, LogicalAgentAvailability } from "../types";
import { AgentMark } from "./AgentMark";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { ICON } from "./icons";
import { agentAvailabilityTone } from "../lib/adminHelpers";

/**
 * Visual agent-state indicator for a task. The agent's profile image carries
 * identity and a readiness pip carries status; the full textual label moves to
 * a tooltip + sr-only text so the board/list stay scannable without a text
 * badge per row. An unassigned task renders a dashed placeholder slot.
 *
 * Identity resolves in three steps: the uploaded profile image, else the
 * name's monogram (the default profile image), else — for callers that only
 * know an executor kind and no logical agent name — the vendor glyph.
 *
 * The pip's tone comes from `agentAvailabilityTone` so it always agrees with
 * the status pill beside it: ready = good, busy = info, pending = warn (both
 * healthy, just occupied — distinct brightness tiers), offline = neutral
 * (absence, not failure). The label is exposed as sr-only text
 * so state is not carried by color alone. Pass `availability` for the
 * tri-state readout; the boolean `ready` prop remains as a two-state
 * fallback for callers that only know routability (e.g. the backlog).
 */
export function AgentStateBadge({
  agent,
  ready,
  availability,
  imageUrl,
  name,
}: {
  agent: AgentName | null | undefined;
  ready: boolean;
  availability?: LogicalAgentAvailability;
  imageUrl?: string | null;
  /** Logical agent display name; drives the default monogram profile image. */
  name?: string;
}) {
  const { t } = useTranslation();

  if (!agent && !name && !imageUrl) {
    const label = t("backlog.no_agent");
    return (
      <Tooltip content={label}>
        <span className="agent-state agent-state--empty">
          <span className="sr-only">{label}</span>
        </span>
      </Tooltip>
    );
  }

  /* One mapping, in adminHelpers, rather than a third hand-rolled copy: this
     pip and the status pill beside it in the roster row describe the same
     fact, and they drifted — the pill called an offline agent neutral while
     the pip called it critical. Without an availability the badge is only
     saying whether the agent can take work, which is not a failure either. */
  const tone = availability
    ? `tone-${agentAvailabilityTone(availability)}`
    : ready
      ? "tone-good"
      : "tone-neutral";
  const stateLabel = availability
    ? t(`status.${availability}`, { defaultValue: availability })
    : ready
      ? t("backlog.ready")
      : t("backlog.not_ready");
  const label = `${name ?? agent} · ${stateLabel}`;
  /* The tooltip is the whole visible label here — the badge itself is an
     avatar and a status pip. `title` put that label behind an OS delay and
     out of reach on touch and keyboard entirely; the `sr-only` span keeps
     carrying it for assistive tech, as it always did. */
  return (
    <Tooltip content={label}>
      <span className={cn("agent-state", tone)} data-agent={agent}>
        {imageUrl || name ? (
          <ProfileImage
            src={imageUrl}
            alt=""
            fallback={name ? <IdentityMark kind="agent" /> : null}
          />
        ) : (
          agent ? <AgentMark agent={agent} size={ICON.sm} /> : <IdentityMark kind="agent" />
        )}
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}
