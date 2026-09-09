"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ActionToggle,
  AdminDelete,
  ICON,
} from "./icons";
import {
  deleteAgentPlacement,
  deleteAgentProfileImage,
  deleteEmployeeAgent,
  getControlPanelAgent,
  updateAgentProfileImage,
  updateEmployeeAgent,
  updateOwnEmployeeAgent,
} from "../api";
import type { AgentPlacement, ControlPanelDaemonNodeRecord, EmployeeAgent } from "../types";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { ADMIN_AGENTS_KEY } from "../lib/adminHelpers";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../hooks/useEmployeeAgents";
import { formatRelativeTime } from "./admin/helpers";
import { IdentityMark } from "./IdentityMark";
import { AgentProfileEditor } from "./AgentProfileEditor";
import { PlacementList } from "./PlacementList";
import { describeAgentPlacements, placementRuntimeNodeId } from "../lib/agentPlacements";
import { ProfileImagePicker } from "./ProfileImagePicker";
import { Alert } from "@/components/ui/alert";

export interface AgentProfilePanelProps {
  agent: EmployeeAgent;
  nodes?: ControlPanelDaemonNodeRecord[];
  canManage?: boolean;
  canEditMeta?: boolean;
  onAgentUpdated?: (agent: EmployeeAgent) => void;
  onAgentDeleted?: (agentId: string) => void;
  /** Reports unsaved profile drafts so parents can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function AgentProfilePanel({
  agent,
  nodes = [],
  canManage = false,
  canEditMeta = false,
  onAgentUpdated,
  onAgentDeleted,
  onDirtyChange,
}: AgentProfilePanelProps) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const queryClient = useQueryClient();
  const canEditProfile = canManage || canEditMeta;

  const [nameDraft, setNameDraft] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [personalityDraft, setPersonalityDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPlacementId, setPendingPlacementId] = useState<string | null>(null);

  const dirtyDraft = editingProfile && (
    nameDraft.trim() !== agent.displayName.trim()
    || personalityDraft.trim() !== (agent.instructions ?? "").trim()
  );
  const dirtyDraftRef = useRef(false);
  dirtyDraftRef.current = dirtyDraft;

  useEffect(() => {
    onDirtyChange?.(dirtyDraft);
  }, [dirtyDraft, onDirtyChange]);

  const previousAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousAgentIdRef.current === agent.id) return;
    const hadDirtyDraft = dirtyDraftRef.current;
    previousAgentIdRef.current = agent.id;
    const resetEditingState = () => {
      setEditingProfile(false);
      setError(null);
      setSaving(false);
      setPendingPlacementId(null);
    };
    // Hold the draft until the owner confirms the discard — switching rows
    // must not silently drop an unsaved profile edit.
    if (!hadDirtyDraft) {
      resetEditingState();
      return;
    }
    void confirm({
      title: t("unsaved.title"),
      message: t("unsaved.message"),
      confirmLabel: t("unsaved.confirm"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    }).then((ok) => {
      if (ok) resetEditingState();
    });
  }, [agent.id, confirm, t]);

  async function patchAgent(patch: Parameters<typeof updateEmployeeAgent>[1]) {
    if (canManage) {
      return updateEmployeeAgent(agent.id, patch);
    }
    return updateOwnEmployeeAgent(agent.id, {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    });
  }

  function applyAgentUpdate(updated: EmployeeAgent) {
    queryClient.setQueryData(["admin", "agent", updated.id], { agent: updated });
    void queryClient.invalidateQueries({ queryKey: ADMIN_AGENTS_KEY });
    void queryClient.invalidateQueries({ queryKey: [EMPLOYEE_AGENTS_QUERY_KEY] });
    onAgentUpdated?.(updated);
  }

  function startEditProfile() {
    setNameDraft(agent.displayName);
    setPersonalityDraft(agent.instructions ?? "");
    setEditingProfile(true);
    setError(null);
  }

  async function handleProfileSave() {
    const trimmedName = nameDraft.trim();
    const trimmedPersonality = personalityDraft.trim();
    const nameChanged = trimmedName !== agent.displayName.trim();
    const personalityChanged = trimmedPersonality !== (agent.instructions ?? "").trim();
    if (!nameChanged && !personalityChanged) {
      setEditingProfile(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await patchAgent({
        ...(nameChanged ? { displayName: trimmedName } : {}),
        ...(personalityChanged ? { instructions: trimmedPersonality } : {}),
      });
      if (!result) return;
      applyAgentUpdate(result.agent);
      setEditingProfile(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled() {
    setSaving(true);
    setError(null);
    try {
      const result = await patchAgent({ enabled: !agent.enabled });
      if (!result) return;
      applyAgentUpdate(result.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleImageUpload(dataUrl: string) {
    setSaving(true);
    setError(null);
    try {
      const result = await updateAgentProfileImage(agent.id, dataUrl);
      applyAgentUpdate(result.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleImageRemove() {
    setSaving(true);
    setError(null);
    try {
      const result = await deleteAgentProfileImage(agent.id);
      applyAgentUpdate(result.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAgent() {
    const ok = await confirm({
      title: t("admin.v2.delete_agent_confirm", { name: agent.displayName }),
      message: t("admin.v2.delete_agent_message"),
      confirmLabel: t("admin.v2.delete_agent"),
      tone: "danger",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await deleteEmployeeAgent(agent.id);
      void queryClient.invalidateQueries({ queryKey: ADMIN_AGENTS_KEY });
      onAgentDeleted?.(agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  async function handleRemovePlacement(placement: AgentPlacement) {
    const runtimeNodeId = placementRuntimeNodeId(placement);
    const node = nodes.find((item) => item.id === runtimeNodeId);
    const ok = await confirm({
      title: t("admin.v2.remove_placement_confirm", {
        node: node?.displayName || placement.nodeDisplayName || runtimeNodeId,
      }),
      message: t("admin.v2.remove_placement_message"),
      confirmLabel: t("admin.v2.remove_placement"),
      tone: "danger",
    });
    if (!ok) return;
    setPendingPlacementId(placement.id);
    setError(null);
    try {
      await deleteAgentPlacement(placement.id);
      const refreshed = await getControlPanelAgent(agent.id);
      applyAgentUpdate(refreshed.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingPlacementId(null);
    }
  }

  const placementDescriptions = describeAgentPlacements(agent.placements);
  const skills = agent.skills ?? [];

  /* The profile tab carries only what you can CHANGE about the record —
     portrait, name, role, instructions. Runtime, computer, availability,
     and id are printed once by the RecordBand above every tab, and the
     page header owns the agent's name, so identity here shrinks to one
     portrait + role row above the document. A rail restating the name
     (as the old two-column dossier did) would put the same fact on
     screen twice. */
  return (
    <div className="workspace-profile-panel workspace-profile-dossier agent-dossier">
      <div className="agent-dossier-identity">
        <ProfileImagePicker
          imageUrl={agent.profileImageUrl}
          name={agent.displayName}
          fallback={<IdentityMark kind="agent" />}
          editable={canEditProfile}
          disabled={saving}
          onUpload={handleImageUpload}
          onRemove={handleImageRemove}
        />
        <div className="agent-dossier-identity-meta">
          <div className="workspace-dossier-field">
            <span className="workspace-dossier-field-label" id="agent-default-role-label">
              {t("admin.v2.agent_role_label")}
            </span>
            {/* Role is set at creation and immutable thereafter (birth
                certificate field) — always render read-only, never editable. */}
            <span className="workspace-dossier-field-value" aria-labelledby="agent-default-role-label">
              {agent.defaultRole
                ? t(`admin.v2.agent_role.${agent.defaultRole}`, { defaultValue: agent.defaultRole })
                : t("admin.v2.agent_role_none")}
            </span>
          </div>
          <p className="workspace-dossier-stamp">
            {t("admin.v2.agent_meta_version", { version: agent.version })}
            {" · "}
            {t("admin.v2.agent_meta_created", { time: formatRelativeTime(agent.createdAt, t) })}
            {" · "}
            {t("admin.v2.agent_meta_updated", { time: formatRelativeTime(agent.updatedAt, t) })}
          </p>
        </div>
      </div>

      <div className="workspace-dossier-doc">
        <AgentProfileEditor
          name={agent.displayName}
          nameDraft={nameDraft}
          personality={agent.instructions ?? ""}
          personalityDraft={personalityDraft}
          editing={editingProfile}
          editable={canEditProfile}
          saving={saving}
          onStartEdit={startEditProfile}
          onNameDraftChange={setNameDraft}
          onPersonalityDraftChange={setPersonalityDraft}
          onCancel={() => setEditingProfile(false)}
          onSave={() => void handleProfileSave()}
        />
        {canEditProfile && error ? (
          <Alert variant="boxed">{t("admin.v2.action_failed", { message: error })}</Alert>
        ) : null}
      </div>

      {/* What this agent can actually do on its computer. Node-reported, so
          it is read-only here: installing a skill happens on the machine,
          not in the record. */}
      <div className="adm-drawer-section agent-dossier-skills">
        <p className="workspace-dossier-section-title">{t("agents_page.skills_title")}</p>
        {skills.length === 0 ? (
          <p className="adm-cred-empty">{t("agents_page.skills_empty")}</p>
        ) : (
          <ul className="agent-skill-list">
            {skills.map((skill) => (
              <li key={`${skill.namespace ?? ""}/${skill.name}`} className="agent-skill">
                <span className="agent-skill-name code" translate="no">
                  {skill.namespace ? `${skill.namespace}/${skill.name}` : skill.name}
                </span>
                {skill.description ? (
                  <span className="agent-skill-description">{skill.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Management lives at the foot of the record — it acts on the whole
          agent, not on the identity row or the document. */}
      {canEditProfile ? (
        <div className="workspace-dossier-admin">
          {canManage ? (
            <>
              <div className="adm-drawer-section-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleToggleEnabled()}
                  disabled={saving}
                >
                  <ActionToggle size={ICON.sm} aria-hidden="true" />
                  {agent.enabled ? t("admin.v2.agent_disable_action") : t("admin.v2.agent_enable_action")}
                </Button>
              </div>

              <div className="adm-drawer-section">
                <p className="workspace-dossier-section-title">{t("admin.v2.agent_placements_title")}</p>
                {placementDescriptions.length === 0 ? (
                  <p className="adm-cred-empty">{t("admin.v2.no_runtime_placement")}</p>
                ) : (
                  <PlacementList
                    descriptions={placementDescriptions}
                    canManage
                    pendingPlacementId={pendingPlacementId}
                    onRemove={(placement) => void handleRemovePlacement(placement)}
                    nodeMissingFor={(description) => nodes.length > 0
                      && !nodes.some((node) => node.id === placementRuntimeNodeId(description.placement))}
                  />
                )}
              </div>
            </>
          ) : null}

          <div className="adm-drawer-section">
            <p className="workspace-dossier-section-title">{t("admin.v2.danger_zone")}</p>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteAgent()}
              disabled={saving}
            >
              <AdminDelete size={ICON.sm} aria-hidden="true" />
              {t("admin.v2.delete_agent")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
