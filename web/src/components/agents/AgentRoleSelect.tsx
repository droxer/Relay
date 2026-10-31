"use client";

import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_ROLE_OPTIONS } from "../../types";
import type { AgentRole } from "../../types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AgentRoleSelectProps {
  value: AgentRole | "";
  onChange: (role: AgentRole) => void;
  labelledBy: string;
  disabled?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  errorId?: string;
  error?: boolean;
}

/** The agent's own role — one picker shared by setup and the profile form. */
export function AgentRoleSelect({
  value,
  onChange,
  labelledBy,
  disabled = false,
  triggerRef,
  errorId,
  error = false,
}: AgentRoleSelectProps) {
  const { t } = useTranslation();
  const label = (role: string | null) => role
    ? t(`admin.v2.agent_role.${role}`, { defaultValue: role })
    : t("agents_page.create_role_placeholder");

  return (
    <Select
      value={value || null}
      onValueChange={(next) => {
        if (next) onChange(next as AgentRole);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        ref={triggerRef}
        className="w-full"
        aria-labelledby={labelledBy}
        aria-invalid={error || undefined}
        aria-describedby={error ? errorId : undefined}
      >
        <SelectValue placeholder={t("agents_page.create_role_placeholder")}>
          {(current: string | null) => label(current)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {AGENT_ROLE_OPTIONS.map((role) => (
          <SelectItem key={role} value={role}>{label(role)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
