"use client";

import { useTranslation } from "react-i18next";
import { AGENT_ROLE_OPTIONS } from "../../types";
import type { AgentRole } from "../../types";
import { SelectItem } from "@/components/ui/select";

/** Every role picker's options: the roles in Pipeline order, each with the
    one line that tells it apart. The trigger keeps the title alone. */
export function RoleSelectItems({ label }: { label: (role: AgentRole) => string }) {
  const { t } = useTranslation();
  return AGENT_ROLE_OPTIONS.map((role) => (
    <SelectItem key={role} value={role} aria-label={label(role)}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label(role)}</span>
        <span className="text-sm leading-normal text-muted-foreground">{t(`role_hints.${role}`)}</span>
      </span>
    </SelectItem>
  ));
}
