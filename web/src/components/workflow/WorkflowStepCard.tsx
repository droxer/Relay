"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { UserAgent } from "../../types";
import type { WorkflowFieldError, WorkflowStepDraft, WorkflowStepField } from "../../lib/workflowTeamDraft";
import { WORKFLOW_LIMITS, withStepKind } from "../../lib/workflowTeamDraft";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RosterAgentItem, RosterTriggerValue } from "../roster/RosterOption";
import { AdminDelete, ChevronDownIcon, ChevronUpIcon, ICON, NavMore } from "../icons";

type Props = {
  step: WorkflowStepDraft;
  index: number;
  count: number;
  agents: UserAgent[];
  errors?: Partial<Record<WorkflowStepField, WorkflowFieldError>>;
  disabled?: boolean;
  onChange: (patch: Partial<WorkflowStepDraft>) => void;
  onReplace: (next: WorkflowStepDraft) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
};

const KINDS = ["work", "deployment"] as const;

/** One ordered step: its name, the Project Agent who owns it, what it must
 *  record, and whether a person approves it first. Reordering is by buttons
 *  (and the phone's action sheet), never drag, so touch and keyboard both work. */
export function WorkflowStepCard({
  step, index, count, agents, errors = {}, disabled, onChange, onReplace, onMove, onRemove,
}: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const id = (field: string) => `${uid}-${field}`;
  const errorText = (field: WorkflowStepField) => {
    const code = errors[field];
    if (!code) return undefined;
    const limit = field === "instructions" ? WORKFLOW_LIMITS.instructions
      : field === "name" ? WORKFLOW_LIMITS.name : WORKFLOW_LIMITS.line;
    return t(`workflow.error_${code}`, { limit, max: WORKFLOW_LIMITS.lines });
  };
  const described = (field: WorkflowStepField, slug: string) => ({
    "aria-invalid": Boolean(errors[field]) || undefined,
    "aria-describedby": errors[field] ? id(`${slug}-error`) : undefined,
  });
  const stepLabel = t("workflow.step_label", { index: index + 1 });
  const first = index === 0;
  const last = index === count - 1;

  return (
    <li className="workflow-step-card" aria-labelledby={id("title")} data-kind={step.kind}>
      <div className="workflow-step-head">
        <span className="workflow-step-index tnum" aria-hidden="true">{index + 1}</span>
        <h3 id={id("title")} className="workflow-step-title">
          <span className="workflow-step-title-text">{step.name.trim() || stepLabel}</span>
          {step.requiresApproval ? <span className="workflow-step-gate">{t("workflow.gate_badge")}</span> : null}
        </h3>
        <div className="workflow-step-actions">
          <Button type="button" variant="ghost" size="icon-dense" className="workflow-step-move"
            aria-label={t("workflow.move_up", { step: stepLabel })} disabled={disabled || first} onClick={() => onMove(index - 1)}>
            <ChevronUpIcon size={ICON.sm} aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-dense" className="workflow-step-move"
            aria-label={t("workflow.move_down", { step: stepLabel })} disabled={disabled || last} onClick={() => onMove(index + 1)}>
            <ChevronDownIcon size={ICON.sm} aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled}
              render={(
                <Button type="button" variant="ghost" size="icon-dense" aria-label={t("workflow.step_actions", { step: stepLabel })}>
                  <NavMore size={ICON.sm} aria-hidden="true" />
                </Button>
              )}
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={first} onClick={() => onMove(0)}>{t("workflow.move_first")}</DropdownMenuItem>
              <DropdownMenuItem disabled={first} onClick={() => onMove(index - 1)}>{t("workflow.move_up_short")}</DropdownMenuItem>
              <DropdownMenuItem disabled={last} onClick={() => onMove(index + 1)}>{t("workflow.move_down_short")}</DropdownMenuItem>
              <DropdownMenuItem disabled={last} onClick={() => onMove(count - 1)}>{t("workflow.move_last")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger disabled={count <= 1} onClick={onRemove}>
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("workflow.step_remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="workflow-step-fields">
        <Field label={t("workflow.step_name")} error={errorText("name")} errorId={id("name-error")}>
          <Input
            value={step.name}
            maxLength={WORKFLOW_LIMITS.name}
            autoComplete="off"
            disabled={disabled}
            placeholder={t("workflow.step_name_placeholder")}
            onChange={(event) => onChange({ name: event.target.value })}
            {...described("name", "name")}
          />
        </Field>
        <Field label={t("workflow.step_agent")} labelId={id("agent-label")} wrapper="div" error={errorText("agentId")} errorId={id("agent-error")}>
          <Select value={step.agentId} onValueChange={(value) => onChange({ agentId: String(value ?? "") })} disabled={disabled}>
            <SelectTrigger className="w-full" aria-labelledby={id("agent-label")} {...described("agentId", "agent")}>
              <SelectValue placeholder={t("workflow.step_agent_placeholder")}>
                {(value: string | null) => {
                  const picked = agents.find((agent) => agent.id === value);
                  return picked ? <RosterTriggerValue agent={picked} /> : t("workflow.step_agent_placeholder");
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup aria-label={t("workflow.step_agent")}>
                {agents.map((agent) => <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("workflow.step_instructions")} error={errorText("instructions")} errorId={id("instructions-error")} className="workflow-step-wide">
          <Textarea
            rows={3}
            value={step.instructions}
            maxLength={WORKFLOW_LIMITS.instructions}
            disabled={disabled}
            onChange={(event) => onChange({ instructions: event.target.value })}
            {...described("instructions", "instructions")}
          />
        </Field>
        <Field label={t("workflow.step_outputs")} hint={t("team_work.one_per_line")} error={errorText("expectedOutputs")} errorId={id("outputs-error")}>
          <Textarea
            rows={2}
            value={step.expectedOutputs}
            disabled={disabled}
            onChange={(event) => onChange({ expectedOutputs: event.target.value })}
            {...described("expectedOutputs", "outputs")}
          />
        </Field>
        <Field label={t("workflow.step_criteria")} hint={t("team_work.one_per_line")} error={errorText("acceptanceCriteria")} errorId={id("criteria-error")}>
          <Textarea
            rows={2}
            value={step.acceptanceCriteria}
            disabled={disabled}
            onChange={(event) => onChange({ acceptanceCriteria: event.target.value })}
            {...described("acceptanceCriteria", "criteria")}
          />
        </Field>
      </div>

      <div className="workflow-step-policy">
        <RadioGroup
          className="workflow-step-kind"
          aria-label={t("workflow.step_kind")}
          value={step.kind}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "work" || value === "deployment") onReplace(withStepKind(step, value));
          }}
        >
          {KINDS.map((kind) => (
            <RadioGroupChoice key={kind} value={kind} className="workflow-step-kind-choice">
              {t(`workflow.kind_${kind}`)}
            </RadioGroupChoice>
          ))}
        </RadioGroup>
        <label className="workflow-step-flag">
          <Checkbox
            checked={step.requiresApproval}
            disabled={disabled}
            onCheckedChange={(value) => onChange({ requiresApproval: value === true })}
          />
          <span>{t("workflow.requires_approval")}</span>
        </label>
      </div>
    </li>
  );
}
