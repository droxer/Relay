"use client";

import { useTranslation } from "react-i18next";
import { ChoiceGroup } from "@/components/ui/choice-group";

/** Who runs a Project's work: one Project Agent, or a Project Workflow whose
 *  steps name the agents. A task carries one or the other, never both. */
export type AssignmentKind = "agent" | "workflow";

/** The segmented Agent | Workflow switch above the drawer's assignment picker.
 *  A radio group, not a toggle group: it sets a value the form saves. */
export function AssignmentKindSwitch({ value, onChange, disabled }: {
  value: AssignmentKind;
  onChange: (kind: AssignmentKind) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceGroup<AssignmentKind>
      size="compact"
      aria-label={t("backlog.assignment_kind")}
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      options={[
        { value: "agent", label: t("backlog.assignment_kind_agent") },
        { value: "workflow", label: t("backlog.assignment_kind_workflow") },
      ]}
    />
  );
}
