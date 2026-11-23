"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listControlPanelAgents } from "../api";
import { userAgentRosterOptions } from "../hooks/useUserAgents";
import type { UserAgent } from "../types";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert } from "@/components/ui/alert";
import { RosterAgentMark } from "./roster/RosterOption";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";

/* A target that was removed or moved keeps a row so it can be unchecked; it
   still gets a face, the neutral agent mark, so no row in the list is bare. */
function UnavailableAgentMark() {
  return (
    <span className="agent-state tone-neutral" aria-hidden="true">
      <ProfileImage src={null} alt="" fallback={<IdentityMark kind="agent" />} />
    </span>
  );
}

export function AgentDelegationSettings({ agent, editable, admin = false, onChange }: {
  agent: UserAgent;
  editable: boolean;
  admin?: boolean;
  onChange: (ids: string[] | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const [selected, setSelected] = useState<string[] | null>(agent.delegationAgentIds ?? null);
  useEffect(() => {
    if (!pending.current) setSelected(agent.delegationAgentIds ?? null);
  }, [agent.delegationAgentIds]);
  const ownerId = agent.supervisorUserId;
  const visible = editable || selected === null || selected.length > 0;
  const roster = useQuery({
    ...(admin ? {
      queryKey: ["delegation-agents", "admin", ownerId],
      queryFn: ({ signal }: { signal: AbortSignal }) => listControlPanelAgents(ownerId, signal),
    } : userAgentRosterOptions(ownerId)),
    enabled: Boolean(ownerId) && visible,
    staleTime: 30_000,
  });
  const candidates = (roster.data?.agents ?? []).filter((other) => other.id !== agent.id && other.enabled
    && other.computerId === agent.computerId && other.supervisorUserId === agent.supervisorUserId);
  // Keep revoked/deleted or moved targets removable even when no longer eligible.
  const allEligible = selected === null;
  const custom = selected ?? [];
  const missing = custom.filter((id) => !candidates.some((candidate) => candidate.id === id));
  async function save(next: string[] | null) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onChange(next);
      setSelected(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  if (!visible) return null;
  return (
    <fieldset className="agent-delegation-settings" disabled={saving || !editable} aria-busy={saving}>
      <legend>{t("delegation.can_delegate_to")}</legend>
      <p>{t("delegation.settings_help")}</p>
      <label className="agent-delegation-option">
        <Checkbox checked={allEligible} disabled={saving || !editable}
          onCheckedChange={(checked) => void save(checked ? null : [])} />
        <span>{t("delegation.all_eligible")}</span>
      </label>
      {roster.isLoading ? <p role="status">{t("delegation.loading")}</p> : null}
      {roster.error ? <Alert variant="boxed">{t("delegation.load_failed")}</Alert> : null}
      {!roster.isLoading && !roster.error && !candidates.length && !missing.length ? <p>{t("delegation.no_targets")}</p> : null}
      {[
        ...candidates.map((target) => ({ id: target.id, name: target.displayName, mark: <RosterAgentMark agent={target} /> })),
        ...missing.map((id) => ({ id, name: t("delegation.unavailable_target"), mark: <UnavailableAgentMark /> })),
      ].map((target) => (
        <label key={target.id} className="agent-delegation-option">
          <Checkbox checked={allEligible || custom.includes(target.id)} disabled={saving || !editable || allEligible || (!custom.includes(target.id) && custom.length >= 20)}
            onCheckedChange={(checked) => void save(checked ? [...custom, target.id] : custom.filter((id) => id !== target.id))} />
          {target.mark}
          <span>{target.name}</span>
        </label>
      ))}
      {error ? <Alert variant="boxed" role="alert">{error}</Alert> : null}
    </fieldset>
  );
}
