"use client";

import { useId } from "react";
import type { AgentName, AgentPlacement } from "../types";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentMetaLine } from "./AgentMetaLine";

/* One team-member pick row. TeamDrawer and TeamWorkspacePage both used to
   render this label+checkbox+name+kind anatomy by hand; the checkbox is the
   shared primitive so the check affordance stops being OS chrome. The meta
   line is <AgentMetaLine>, the same component the roster and the team profile
   render — this file used to claim it matched the roster while drawing its own
   glyph-less, one-rung-larger version. */
export function TeamMemberOption({
  agentId,
  displayName,
  executorKind,
  placements = [],
  selected,
  disabled = false,
  onToggle,
}: {
  agentId: string;
  displayName: string;
  executorKind: AgentName;
  placements?: AgentPlacement[];
  selected: boolean;
  disabled?: boolean;
  onToggle: (agentId: string) => void;
}) {
  const nameId = useId();
  return (
    <label
      className="team-member-option"
    >
      {/* base-ui points the control's aria-labelledby at the wrapping <label>,
          whose text is the name PLUS the meta line — and an aria-label here is
          concatenated onto that rather than replacing it, so the row announced
          "Builder Builder Codex · Not placed". Pointing aria-labelledby at the
          name alone makes the accessible name the member's name, and leaves
          the meta line as the visible detail it is. */}
      <Checkbox
        checked={selected}
        disabled={disabled}
        onCheckedChange={() => onToggle(agentId)}
        aria-labelledby={nameId}
      />
      <span className="team-member-option-main">
        <span className="team-member-option-name" id={nameId}>{displayName}</span>
        <AgentMetaLine
          executorKind={executorKind}
          placements={placements}
          className="team-member-option-meta"
        />
      </span>
    </label>
  );
}
