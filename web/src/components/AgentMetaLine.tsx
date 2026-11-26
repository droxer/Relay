"use client";

import { useTranslation } from "react-i18next";
import { activePlacements, describeAgentPlacements } from "../lib/agentPlacements";
import { agentLabel } from "../lib/plan";
import type { AgentName, AgentPlacementRoute } from "../types";

/** Runtime, model, and active placements for an Agents list row. */
export function AgentMetaLine({
  executorKind,
  placements,
  className,
  showComputers = true,
  model,
}: {
  executorKind: AgentName;
  placements: readonly AgentPlacementRoute[];
  /** The agent's pinned model id; "" is the runtime default. Omit on
      surfaces that do not carry the agent's model policy. */
  model?: string;
  className?: string;
  /** Pass `false` where the surface already bands rows by computer — the
      band names it, so the row would only restate it. The tooltip keeps the
      full placement list either way. */
  showComputers?: boolean;
}) {
  const { t } = useTranslation();
  const descriptions = describeAgentPlacements(activePlacements(placements));
  const runtime = agentLabel(executorKind);
  const modelLabel = model === undefined ? null : model || t("agents_page.model_default");
  const modelTitle = modelLabel ? ` · ${t("agents_page.model_label")}: ${modelLabel}` : "";
  const computerNames = descriptions.map(({ nodeName }) => nodeName).join(", ");

  return (
    <span
      className={`agent-meta${className ? ` ${className}` : ""}`}
      title={
        descriptions.length
          ? `${t("agents_page.runtime")}: ${runtime}${modelTitle} · ${t("agents_page.computers")}: ${computerNames}`
          : `${t("agents_page.runtime")}: ${runtime}${modelTitle} · ${t("agents_page.no_placements")}`
      }
    >
      <span className="agent-meta-runtime">
        <span className="sr-only">{t("agents_page.runtime")}: </span>
        <span className="agent-meta-runtime-label" translate="no">{runtime}</span>
      </span>
      {modelLabel ? (
        <>
          <span className="agent-meta-separator" aria-hidden="true">·</span>
          <span className="agent-meta-model" translate={model ? "no" : undefined}>
            <span className="sr-only">{t("agents_page.model_label")}: </span>
            {modelLabel}
          </span>
        </>
      ) : null}
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
