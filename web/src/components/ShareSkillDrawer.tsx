"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { grantSkill, revokeSkill } from "../api";
import type { AgentTeam, EmployeeAgent, SkillDetail } from "../types";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../hooks/useEmployeeAgents";
import { SKILLS_QUERY_KEY } from "../hooks/useSkills";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer } from "@/components/ui/Drawer";

export function ShareSkillDrawer({
  skill,
  agents,
  teams,
  onClose,
}: {
  skill: SkillDetail;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = useMemo(
    () => new Set(skill.grantedAgentIds),
    [skill.grantedAgentIds],
  );
  const candidates = agents.filter(
    (agent) => agent.enabled && !granted.has(agent.id),
  );
  function toggle(id: string) {
    setSelected((value) =>
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id],
    );
  }
  function selectTeam(team: AgentTeam) {
    setSelected((value) => [
      ...new Set([
        ...value,
        ...team.memberAgentIds.filter((id) =>
          candidates.some((a) => a.id === id),
        ),
      ]),
    ]);
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
      await grantSkill(skill.id, selected);
      await refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  async function revoke(agentId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeSkill(skill.id, agentId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open
      onClose={onClose}
      title={skill.displayName}
      kicker="Share managed skill"
      closeLabel="Close"
      bodyClassName="skill-drawer"
    >
        <p className="skill-muted">
          Grants are delivered to each logical agent on its next run. Revoking a
          grant also takes effect on the next run.
        </p>
        {teams.length ? (
          <section>
            <h3>Teams</h3>
            <div className="skill-team-row">
              {teams.map((team) => (
                <Button
                  key={team.id}
                  variant="outline"
                  onClick={() => selectTeam(team)}
                  disabled={busy}
                >
                  {team.name} · {team.memberAgentIds.length}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>Agents</h3>
          <div className="skill-picker-list">
            {candidates.map((agent) => (
              <label key={agent.id}>
                <Checkbox
                  checked={selected.includes(agent.id)}
                  onCheckedChange={() => toggle(agent.id)}
                />
                <span>
                  <strong>{agent.displayName}</strong>
                  <small>{agent.executorKind}</small>
                </span>
              </label>
            ))}
            {!candidates.length ? (
              <p className="skill-muted">
                All available agents already have this skill.
              </p>
            ) : null}
          </div>
        </section>
        {skill.grantedAgentIds.length ? (
          <section>
            <h3>Granted</h3>
            <div className="skill-grant-list">
              {skill.grantedAgentIds.map((id) => {
                const agent = agents.find((a) => a.id === id);
                return (
                  <div key={id}>
                    <span>{agent?.displayName ?? id}</span>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revoke(id)}
                    >
                      Revoke
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
            Cancel
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => void submit()}
          >
            {busy ? "Sharing…" : `Share with ${selected.length || "selected"}`}
          </Button>
        </footer>
    </Drawer>
  );
}
