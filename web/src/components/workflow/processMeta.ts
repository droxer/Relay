import type { TFunction } from "i18next";
import type { WorkflowPreview } from "../../types";

/** "N steps", plus the approval count only when there are some; "0 approvals"
 *  is noise. Shared so the Project and Team libraries read alike. */
export function workflowProcessMeta(t: TFunction, steps: WorkflowPreview["workflowSteps"]): string {
  const gates = steps.filter(step => step.requiresApproval).length;
  const count = t("workflow.step_count", { count: steps.length });
  return gates ? `${count} · ${t("workflow.approval_count", { count: gates })}` : count;
}
