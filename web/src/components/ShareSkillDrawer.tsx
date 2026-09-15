"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { assignSkill, revokeSkillAssignment } from "../api";
import type { AgentTeam, EmployeeAgent, SkillDetail } from "../types";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../hooks/useEmployeeAgents";
import { SKILLS_QUERY_KEY } from "../hooks/useSkills";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer } from "@/components/ui/Drawer";
import { useTranslation } from "react-i18next";

export function ShareSkillDrawer({
  skill,
  agents,
  teams,
  employeeId,
  onClose,
}: {
  skill: SkillDetail;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  employeeId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errorText = (value: unknown) => {
    const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
      ? value.code
      : value instanceof Error ? value.message : "unknown";
    return t(`skills.errors.${code}`, { defaultValue: t("skills.errors.unknown") });
  };
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetTypes = {
    employee: { targetType: "employee" as const },
    team: { targetType: "team" as const },
    agent: { targetType: "agent" as const },
  };
  const assignments = skill.assignments ?? [];
  const assigned = useMemo(
    () => new Set(assignments.map((item) => `${item.targetType}:${item.targetId}`)),
    [assignments],
  );
  const candidates = agents.filter(
    (agent) => agent.enabled && !assigned.has(`agent:${agent.id}`),
  );
  function toggle(id: string) {
    setSelected((value) =>
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id],
    );
  }
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [SKILLS_QUERY_KEY] }),
      queryClient.invalidateQueries({ queryKey: [EMPLOYEE_AGENTS_QUERY_KEY] }),
    ]);
  }
  async function submit() {
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    try {
      await Promise.all(selected.map((target) => {
        const separator = target.indexOf(":");
        const targetType = target.slice(0, separator) as "employee" | "team" | "agent";
        const targetId = target.slice(separator + 1);
        return assignSkill(skill.id, { ...targetTypes[targetType], targetId, mode: "optional", pin: "stable", invocation: "implicit" });
      }));
      await refresh();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  async function revoke(assignmentId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeSkillAssignment(skill.id, assignmentId);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open
      onClose={onClose}
      title={skill.displayName}
      kicker={t("skills.share_managed")}
      closeLabel={t("skills.close")}
      bodyClassName="skill-drawer"
    >
        <p className="skill-muted">
          {t("skills.share_delivery_note")}
        </p>
        {/* The only requirement this drawer has is a target; say so rather than
            leaving a disabled Share button as the only signal. */}
        {!selected.length ? (
          <p className="skill-muted skill-requirement">
            {t("skills.select_target_required")}
          </p>
        ) : null}
        {employeeId ? (
          <section>
            <h3>{t("skills.employee_scope")}</h3>
            <Button
              variant="outline"
              className="skill-target-chip"
              aria-pressed={selected.includes(`employee:${employeeId}`)}
              data-selected={selected.includes(`employee:${employeeId}`) ? "true" : undefined}
              onClick={() => toggle(`employee:${employeeId}`)}
              disabled={busy || assigned.has(`employee:${employeeId}`)}
            >
              {t("skills.all_current_future_agents")}
            </Button>
          </section>
        ) : null}
        {teams.length ? (
          <section>
            <h3>{t("skills.teams")}</h3>
            <div className="skill-team-row">
              {teams.map((team) => (
                <Button
                  key={team.id}
                  variant="outline"
                  className="skill-target-chip"
                  aria-pressed={selected.includes(`team:${team.id}`)}
                  data-selected={selected.includes(`team:${team.id}`) ? "true" : undefined}
                  onClick={() => toggle(`team:${team.id}`)}
                  disabled={busy || assigned.has(`team:${team.id}`)}
                >
                  {team.name} · {t("skills.member_count", { count: team.memberAgentIds.length })}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>{t("skills.agents")}</h3>
          <div className="skill-picker-list">
            {candidates.map((agent) => (
              <label
                key={agent.id}
                data-selected={selected.includes(`agent:${agent.id}`) ? "true" : undefined}
              >
                <Checkbox
                  checked={selected.includes(`agent:${agent.id}`)}
                  onCheckedChange={() => toggle(`agent:${agent.id}`)}
                />
                <span>
                  <strong>{agent.displayName}</strong>
                  <small>{agent.executorKind}</small>
                </span>
              </label>
            ))}
            {!candidates.length ? (
              <p className="skill-muted">
                {t("skills.all_agents_granted")}
              </p>
            ) : null}
          </div>
        </section>
        {assignments.length ? (
          <section>
            <h3>{t("skills.granted")}</h3>
            <div className="skill-grant-list">
              {assignments.map((assignment) => {
                const agent = assignment.targetType === "agent" ? agents.find((a) => a.id === assignment.targetId) : undefined;
                const team = assignment.targetType === "team" ? teams.find((item) => item.id === assignment.targetId) : undefined;
                const label = assignment.targetType === "employee"
                  ? t("skills.all_current_future_agents")
                  : agent?.displayName ?? team?.name ?? assignment.targetId;
                return (
                  <div key={assignment.id}>
                    <span>{label}</span>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revoke(assignment.id)}
                    >
                      {t("skills.revoke")}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {error ? (
          <p className="skill-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <Button variant="outline" onClick={onClose}>
            {t("skills.cancel")}
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => void submit()}
          >
            {busy ? t("skills.sharing") : t("skills.share_with_count", { count: selected.length })}
          </Button>
        </footer>
    </Drawer>
  );
}
