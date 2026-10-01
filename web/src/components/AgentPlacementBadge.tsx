"use client";

import { useTranslation } from "react-i18next";
import { StateMark } from "./StateMark";
import { Tooltip } from "@/components/ui/tooltip";
import {
  placementBadgeDetailLabels,
  placementBadgeShowsSandbox,
  placementStatusTone,
  type AgentPlacementDescription,
} from "../lib/agentPlacements";
import { ICON, nodeOwnershipIcon } from "./icons";
import { Badge } from "@/components/ui/badge";

export function AgentPlacementBadge({
  description,
  showSandbox = false,
}: {
  description: AgentPlacementDescription;
  showSandbox?: boolean;
}) {
  const { t } = useTranslation();
  const OwnershipIcon = nodeOwnershipIcon(description.ownership);
  const ownershipLabel = t(`admin.v2.node_ownership_${description.ownership}`);
  const sandboxLabel = t(`admin.v2.node_sandbox_${description.sandbox}`);
  const status = description.placement.status;
  const statusLabel = t(`admin.v2.placement_status.${status}`, { defaultValue: status });
  const showsSandbox = placementBadgeShowsSandbox(description.sandbox, showSandbox);
  const detailTitle = placementBadgeDetailLabels({
    nodeName: description.nodeName,
    ownership: ownershipLabel,
    sandboxLabel,
    status: statusLabel,
  }, showsSandbox).join(" · ");

  return (
    <Tooltip content={detailTitle}>
      {/* A computer's name is what someone called their machine, not an
          identifier, so it reads in the sans like every other name; the id
          stays monospaced where it is shown (node cards, the copy field). */}
      <Badge
        className="agent-placement-badge"
        data-ownership={description.ownership}
      >
        <StateMark tone={placementStatusTone(status)} />
        <OwnershipIcon size={ICON.sm} aria-hidden="true" />
        <span className="agent-placement-badge-name" translate="no">
          {description.nodeName}
        </span>
        <span className="sr-only">{statusLabel}</span>
        <span className="agent-placement-badge-kind code">{ownershipLabel}</span>
        {showsSandbox ? (
          <span className="agent-placement-badge-sandbox code">{sandboxLabel}</span>
        ) : null}
      </Badge>
    </Tooltip>
  );
}
