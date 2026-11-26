"use client";

import { useTranslation } from "react-i18next";
import { AGENT_ROLE_LEVEL_OPTIONS, type AgentRoleLevel } from "../../types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE_VALUE = "__none__";

interface AgentRoleLevelSelectProps {
  value: AgentRoleLevel | "";
  onChange: (level: AgentRoleLevel | "") => void;
  labelledBy: string;
  disabled?: boolean;
}

/** Optional seniority selector (Junior / Senior) shared by Agent, Project, and Team forms. */
export function AgentRoleLevelSelect({
  value,
  onChange,
  labelledBy,
  disabled = false,
}: AgentRoleLevelSelectProps) {
  const { t } = useTranslation();
  const label = (level: string | null) =>
    level && level !== NONE_VALUE
      ? t(`role_levels.${level}`, { defaultValue: level })
      : t("role_levels.standard");

  return (
    <Select
      value={value || NONE_VALUE}
      onValueChange={(next) => {
        onChange(next && next !== NONE_VALUE ? (next as AgentRoleLevel) : "");
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full" aria-labelledby={labelledBy}>
        <SelectValue>{(current: string | null) => label(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE} aria-label={t("role_levels.standard")}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>{t("role_levels.standard")}</span>
            <span className="text-sm leading-normal text-muted-foreground">
              {t("role_level_hints.standard")}
            </span>
          </span>
        </SelectItem>
        {AGENT_ROLE_LEVEL_OPTIONS.map((level) => (
          <SelectItem key={level} value={level} aria-label={t(`role_levels.${level}`)}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{t(`role_levels.${level}`)}</span>
              <span className="text-sm leading-normal text-muted-foreground">
                {t(`role_level_hints.${level}`)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
