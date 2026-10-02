"use client";

import { useTranslation } from "react-i18next";
import { activePlacements, describeAgentPlacements } from "../lib/agentPlacements";
import { agentLabel } from "../lib/plan";
import type { AgentName, AgentPlacement } from "../types";
import { AgentMark } from "./AgentMark";
import { ICON, NodeOwnershipIcon } from "./icons";

/**
 * The one line that annotates an agent: which runtime it is, and which
 * computers it runs on.
 *
 * Three surfaces drew this by hand — the agent roster row, the team profile's
 * member list, and the team member picker — and they had drifted apart on
 * every property that makes it legible:
 *
 *   - the roster showed `[vendor glyph] claude`, both team surfaces showed a
 *     bare `claude` with no glyph at all, so the same agent had a picture on
 *     one screen and none two rows later;
 *   - the roster sat on the compact metadata rung (--fs-1 mono), the team
 *     copies a rung larger at --fs-2, so the team line read heavier than the
 *     agent name it annotates;
 *   - the roster listed every computer in route order, the team copies only
 *     the first, without saying more existed;
 *   - the roster filtered `removed` placements, the team copies did not, so a
 *     torn-down computer lingered in a team after leaving the roster.
 *
 * `TeamMemberOption` even carried the comment "The meta line matches the agent
 * roster". This component is what makes that true.
 */
export function AgentMetaLine({
  executorKind,
  placements,
  className,
  showComputers = true,
}: {
  executorKind: AgentName;
  placements: readonly AgentPlacement[];
  className?: string;
  /** Pass `false` where the surface already bands rows by computer — the
      band names it, so the row would only restate it. The tooltip keeps the
      full placement list either way. */
  showComputers?: boolean;
}) {
  const { t } = useTranslation();
  const descriptions = describeAgentPlacements(activePlacements(placements));
  const runtime = agentLabel(executorKind);
  const computerNames = descriptions.map(({ nodeName }) => nodeName).join(", ");

  return (
    <span
      className={`agent-meta${className ? ` ${className}` : ""}`}
      title={
        descriptions.length
          ? `${t("agents_page.runtime")}: ${runtime} · ${t("agents_page.computers")}: ${computerNames}`
          : `${t("agents_page.runtime")}: ${runtime} · ${t("agents_page.no_placements")}`
      }
    >
      <span className="agent-meta-runtime">
        <span className="sr-only">{t("agents_page.runtime")}: </span>
        <span className="agent-meta-runtime-mark" aria-hidden="true">
          <AgentMark agent={executorKind} size={ICON.xs} />
        </span>
        <span className="agent-meta-runtime-label" translate="no">{runtime}</span>
      </span>
      {showComputers ? (
        <>
          <span className="agent-meta-separator" aria-hidden="true">·</span>
          {descriptions.length ? (
            <span className="agent-meta-computers">
              <span className="sr-only">{t("agents_page.computers")}: </span>
              {descriptions.map((description, index) => {
                return (
                  <span key={description.placement.id} className="agent-meta-computer">
                    {index > 0 ? (
                      <span className="agent-meta-computer-separator" aria-hidden="true">,</span>
                    ) : null}
                    <NodeOwnershipIcon ownership={description.ownership} size={ICON.xs} aria-hidden="true" />
                    <span translate="no">{description.nodeName}</span>
                  </span>
                );
              })}
            </span>
          ) : (
            <span>{t("agents_page.no_placements")}</span>
          )}
        </>
      ) : null}
    </span>
  );
}
