"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentRoleLevel } from "../types";
import { agentRoleLabel, agentRoleName, type AgentRoleIdentity } from "../lib/agentRoleLabel";

/** Compact visual badge for agent seniority (Senior / Junior) so dense rows
 *  never overflow or truncate the role name behind long prefix text. */
export function RoleLevelBadge({
  level,
  compact = true,
  className,
}: {
  level?: AgentRoleLevel | null;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!level) return null;
  const fullLabel = t(`role_levels.${level}`, { defaultValue: level });
  const text = compact
    ? t(`role_levels.badge_${level}`, { defaultValue: level === "senior" ? "Sr" : "Jr" })
    : fullLabel;
  return (
    <Badge
      size="compact"
      variant={level === "senior" ? "warning" : "neutral"}
      className={cn("role-level-badge", compact && "role-level-badge--compact", className)}
      data-role-level={level}
      title={fullLabel}
      aria-label={fullLabel}
    >
      {text}
    </Badge>
  );
}

/** Displays an agent's seniority badge alongside its role name with single-line
 *  ellipsis on the role name so narrow controls stay readable. */
export function AgentRoleMeta({
  identity,
  className = "agent-role-label",
  compact = true,
  empty,
}: {
  identity?: AgentRoleIdentity | null;
  className?: string;
  compact?: boolean;
  empty?: ReactNode;
}) {
  const { t } = useTranslation();
  const roleName = agentRoleName(identity, t);
  const level = identity?.roleLevel ?? null;
  if (!roleName && !level) return empty ?? null;
  const fullLabel = agentRoleLabel(identity, t) ?? (level ? t(`role_levels.${level}`, { defaultValue: level }) : undefined);
  return (
    <span className={cn("agent-role-meta", className)} title={fullLabel}>
      {level ? <RoleLevelBadge level={level} compact={compact} /> : null}
      {roleName ? <span className="agent-role-meta-name">{roleName}</span> : null}
    </span>
  );
}
