"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { assignSkill, revokeSkillAssignment } from "../api";
import type { AgentTeam, EmployeeAgent, SkillDetail } from "../types";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../hooks/useEmployeeAgents";
import { SKILLS_QUERY_KEY } from "../hooks/useSkills";
import { labelForExecutor } from "../lib/agentDisplayNames";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer } from "@/components/ui/Drawer";
import { useTranslation } from "react-i18next";

function TargetRow({
  checked,
  disabled,
  onToggle,
  label,
  meta,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
  meta?: string;
}) {
  return (
    <label className="skill-target" data-selected={checked ? "true" : undefined}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <span className="skill-target-name">{label}</span>
      {meta ? <span className="skill-target-meta">{meta}</span> : null}
    </label>
  );
}

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
  const assignments = useMemo(() => skill.assignments ?? [], [skill.assignments]);
  const assigned = useMemo(
    () => new Set(assignments.map((item) => `${item.targetType}:${item.targetId}`)),
    [assignments],
  );
  const candidates = agents.filter(
    (agent) => agent.enabled && !assigned.has(`agent:${agent.id}`),
  );
  const teamCandidates = teams.filter((team) => !assigned.has(`team:${team.id}`));
  const scopeTarget = employeeId && !assigned.has(`employee:${employeeId}`)
    ? `employee:${employeeId}`
    : null;
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
        {/* Scope, teams, and agents are one kind of choice — a target to
            toggle — so they share one quiet checklist row instead of outline
            chips for two of them and bordered cards for the third. Targets
            that already hold the skill leave the picker; they are listed
            under Granted with their Revoke. */}
        {scopeTarget ? (
          <section>
            <h3>{t("skills.employee_scope")}</h3>
            <div className="skill-target-list">
              <TargetRow
                checked={selected.includes(scopeTarget)}
                disabled={busy}
                onToggle={() => toggle(scopeTarget)}
                label={t("skills.all_current_future_agents")}
              />
            </div>
          </section>
        ) : null}
        {teamCandidates.length ? (
          <section>
            <h3>{t("skills.teams")}</h3>
            <div className="skill-target-list">
              {teamCandidates.map((team) => (
                <TargetRow
                  key={team.id}
                  checked={selected.includes(`team:${team.id}`)}
                  disabled={busy}
                  onToggle={() => toggle(`team:${team.id}`)}
                  label={team.name}
                  meta={t("skills.member_count", { count: team.memberAgentIds.length })}
                />
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>{t("skills.agents")}</h3>
          {candidates.length ? (
            <div className="skill-target-list">
              {candidates.map((agent) => (
                <TargetRow
                  key={agent.id}
                  checked={selected.includes(`agent:${agent.id}`)}
                  disabled={busy}
                  onToggle={() => toggle(`agent:${agent.id}`)}
                  label={agent.displayName}
                  meta={labelForExecutor(agent.executorKind)}
                />
              ))}
            </div>
          ) : (
            <p className="skill-muted">
              {t("skills.all_agents_granted")}
            </p>
          )}
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
                      size="sm"
                      danger
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
          {/* The one requirement, stated beside the button it gates. In the
              body it vanished on the first pick and shifted every row up. */}
          {!selected.length ? (
            <p className="skill-muted skill-share-hint">
              {t("skills.select_target_required")}
            </p>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {t("skills.cancel")}
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => void submit()}
          >
            {busy
              ? t("skills.sharing")
              : selected.length
                ? t("skills.share_with_count", { count: selected.length })
                : t("skills.share")}
          </Button>
        </footer>
    </Drawer>
  );
}
