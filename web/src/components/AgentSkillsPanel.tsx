"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { revokeSkill } from "../api";
import type { EmployeeAgent } from "../types";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../hooks/useEmployeeAgents";
import { SKILLS_QUERY_KEY } from "../hooks/useSkills";
import { SkillPreviewDrawer } from "./SkillPreviewDrawer";

/** Namespaced skills print qualified; the namespace is part of the name. */
function qualifiedName(skill: { name: string; namespace?: string }) {
  return skill.namespace ? `${skill.namespace}/${skill.name}` : skill.name;
}

export interface AgentSkillsPanelProps {
  agent: EmployeeAgent;
  /** Whether the viewer may revoke granted skills. */
  canEdit?: boolean;
}

/* What this agent can actually do on its computer. Node-reported, so the
   installed group is read-only here: installing a skill happens on the
   machine, not in the record. Only catalog grants are revocable. */
export function AgentSkillsPanel({ agent, canEdit = false }: AgentSkillsPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ skillId: string; title: string; channel: "stable" | "latest" } | null>(null);

  const skills = agent.skills ?? [];
  const grantedSkills = skills.filter((skill) => skill.source === "catalog");
  const installedSkills = skills.filter((skill) => skill.source !== "catalog");

  async function handleRevokeSkill(skillId: string) {
    setPending(true);
    setError(null);
    try {
      await revokeSkill(skillId, agent.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [SKILLS_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: [EMPLOYEE_AGENTS_QUERY_KEY] }),
      ]);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : err instanceof Error ? err.message : "unknown";
      setError(t(`skills.errors.${code}`, { defaultValue: t("skills.errors.unknown") }));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="workspace-profile-panel agent-dossier agent-skills-panel">
      {error ? (
        <Alert variant="boxed">{t("admin.v2.action_failed", { message: error })}</Alert>
      ) : null}
      {skills.length === 0 ? (
        <p className="adm-cred-empty">{t("agents_page.skills_empty")}</p>
      ) : (
        <>
          {grantedSkills.length ? (
            <section className="agent-skill-group">
              <p className="workspace-dossier-section-title">{t("skills.agent_granted_group")}</p>
              <ul className="agent-skill-list">
                {grantedSkills.map((skill) => (
                  <li key={`${skill.namespace ?? ""}/${skill.name}`} className="agent-skill">
                    <span className="agent-skill-head">
                      {/* The name is the way in: a granted skill has a bundle
                          in the catalog, so reading it is one click away. */}
                      {skill.skillId ? (
                        <button
                          type="button"
                          className="agent-skill-name code agent-skill-preview"
                          translate="no"
                          onClick={() => setPreview({
                            skillId: skill.skillId!,
                            title: qualifiedName(skill),
                            channel: skill.pin === "latest" ? "latest" : "stable",
                          })}
                        >
                          {qualifiedName(skill)}
                        </button>
                      ) : (
                        <span className="agent-skill-name code" translate="no">
                          {qualifiedName(skill)}
                        </span>
                      )}
                      {skill.available === false ? (
                        <Badge variant="danger">{t("skills.unavailable")}</Badge>
                      ) : null}
                    </span>
                    {skill.description ? (
                      <span className="agent-skill-description">{skill.description}</span>
                    ) : null}
                    {skill.available === false ? (
                      <span className="agent-skill-unavailable">
                        {skill.reason
                          ? t(`skills.skip_reason.${skill.reason}`, { defaultValue: skill.reason })
                          : t("skills.not_supported")}
                      </span>
                    ) : null}
                    {canEdit && skill.skillId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="agent-skill-action"
                        disabled={pending}
                        onClick={() => void handleRevokeSkill(skill.skillId!)}
                      >
                        {t("skills.revoke")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {installedSkills.length ? (
            <section className="agent-skill-group">
              <p className="workspace-dossier-section-title">{t("skills.agent_installed_group")}</p>
              <ul className="agent-skill-list">
                {installedSkills.map((skill) => (
                  <li key={`${skill.namespace ?? ""}/${skill.name}`} className="agent-skill">
                    <span className="agent-skill-head">
                      <span className="agent-skill-name code" translate="no">
                        {qualifiedName(skill)}
                      </span>
                    </span>
                    {skill.description ? (
                      <span className="agent-skill-description">{skill.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="agent-skill-footnote">{t("skills.agent_discovery_note")}</p>
        </>
      )}
      {preview ? (
        <SkillPreviewDrawer
          skillId={preview.skillId}
          fallbackTitle={preview.title}
          channel={preview.channel}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
