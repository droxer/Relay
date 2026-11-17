"use client";

import { useTranslation } from "react-i18next";
import type { WorkflowStep } from "../../types";
import { DisclosureChevron } from "../icons";

/** A saved workflow's steps as one flow, in the same tiles a predefined
 *  Workflow's role slots use: number, step name over its owner, and the gate
 *  when a person approves first. The Project tab, the Team library and the
 *  Team preview share it, so every saved process reads the same way. */
export function WorkflowStepSummary({ steps, agentName, label }: {
  steps: readonly WorkflowStep[];
  agentName: (agentId: string) => string;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <ol className="collab-style-sequence workflow-flow" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} data-gate={step.requiresApproval || undefined}>
          {index > 0 ? <DisclosureChevron aria-hidden="true" className="collab-style-arrow" /> : null}
          <span className="collab-style-step">
            <span className="collab-style-step-avatar tnum" aria-hidden="true">{index + 1}</span>
            <span className="collab-style-step-text">
              <span className="collab-style-step-name">{step.name}<span className="sr-only">: </span></span>
              <span className="collab-style-step-role">{agentName(step.agentId)}</span>
            </span>
            {step.requiresApproval ? <span className="workflow-step-gate">{t("workflow.gate_badge")}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
