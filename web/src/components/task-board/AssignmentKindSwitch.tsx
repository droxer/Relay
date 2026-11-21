"use client";

import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";

/** Who runs a Project's work: one Project Agent, or a Project Workflow whose
 *  steps name the agents. A task carries one or the other, never both. */
export type AssignmentKind = "agent" | "workflow";

const KINDS: readonly AssignmentKind[] = ["agent", "workflow"];

/** The segmented Agent | Workflow switch above the drawer's assignment picker.
 *  A radio group, not a toggle group: it sets a value the form saves. */
export function AssignmentKindSwitch({ value, onChange, disabled }: {
  value: AssignmentKind;
  onChange: (kind: AssignmentKind) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      className="task-assignment-kind"
      aria-label={t("backlog.assignment_kind")}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "agent" || next === "workflow") onChange(next);
      }}
    >
      {KINDS.map((kind) => (
        <RadioGroupChoice key={kind} value={kind} className="task-assignment-kind-item">
          {t(kind === "agent" ? "backlog.assignment_kind_agent" : "backlog.assignment_kind_workflow")}
        </RadioGroupChoice>
      ))}
    </RadioGroup>
  );
}
