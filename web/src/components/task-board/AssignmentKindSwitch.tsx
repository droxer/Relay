"use client";

import { useTranslation } from "react-i18next";
import { ChoiceGroup } from "@/components/ui/choice-group";

/** Who runs a task: one Agent, a Project Workflow (inside a Project), or a
 *  Team (for standalone work). A task carries one kind at a time, never two. */
export type AssignmentKind = "agent" | "team" | "workflow";

/** The segmented Agent | Workflow (project) or Agent | Team (standalone)
 *  switch above the drawer's assignment picker. A radio group, not a toggle
 *  group: it sets a value the form saves. */
export function AssignmentKindSwitch({ value, secondKind = "workflow", onChange, disabled }: {
  value: AssignmentKind;
  secondKind?: "team" | "workflow";
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
        secondKind === "workflow"
          ? { value: "workflow", label: t("backlog.assignment_kind_workflow") }
          : { value: "team", label: t("backlog.assignment_kind_team") },
      ]}
    />
  );
}
