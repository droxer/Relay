"use client";

import { useTranslation } from "react-i18next";
import type { WorkflowStep } from "../../types";

/** A saved workflow's steps as one numbered list: name, owner, and the gate
 *  when a person approves first. The Project tab and the Team page share it. */
export function WorkflowStepSummary({ steps, agentName, label }: {
  steps: readonly WorkflowStep[];
  agentName: (agentId: string) => string;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <ol className="workflow-team-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} className="workflow-team-step">
          <span className="workflow-step-index tnum" aria-hidden="true">{index + 1}</span>
          <span className="workflow-team-step-body">
            <span className="workflow-team-step-name">{step.name}</span>
            <span className="workflow-team-step-agent">{agentName(step.agentId)}</span>
            {step.requiresApproval ? <span className="workflow-step-gate">{t("workflow.gate_badge")}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
