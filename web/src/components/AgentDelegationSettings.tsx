"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listControlPanelAgents, listUserAgents } from "../api";
import type { UserAgent } from "../types";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert } from "@/components/ui/alert";

export function AgentDelegationSettings({ agent, editable, admin = false, onChange }: {
  agent: UserAgent;
  editable: boolean;
  admin?: boolean;
  onChange: (ids: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const [selected, setSelected] = useState(agent.delegationAgentIds ?? []);
  useEffect(() => {
    if (!pending.current) setSelected(agent.delegationAgentIds ?? []);
  }, [agent.delegationAgentIds]);
  const roster = useQuery({
    queryKey: ["delegation-agents", admin ? "admin" : "own", agent.supervisorUserId],
    queryFn: ({ signal }) => admin
      ? listControlPanelAgents(agent.supervisorUserId, signal) : listUserAgents(signal),
    enabled: Boolean(agent.supervisorUserId),
    staleTime: 30_000,
  });
  const candidates = (roster.data?.agents ?? []).filter((other) => other.id !== agent.id && other.enabled
    && other.computerId === agent.computerId && other.supervisorUserId === agent.supervisorUserId);
  // Keep revoked/deleted or moved targets removable even when no longer eligible.
  const missing = selected.filter((id) => !candidates.some((candidate) => candidate.id === id));
  async function toggle(id: string, checked: boolean) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const next = checked ? [...selected, id] : selected.filter((value) => value !== id);
      await onChange(next);
      setSelected(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  if (!editable && !selected.length) return null;
  return (
    <fieldset className="agent-delegation-settings" disabled={saving || !editable} aria-busy={saving}>
      <legend>{t("delegation.can_delegate_to")}</legend>
      <p>{t("delegation.settings_help")}</p>
      {roster.isLoading ? <p role="status">{t("delegation.loading")}</p> : null}
      {roster.error ? <Alert variant="boxed">{t("delegation.load_failed")}</Alert> : null}
      {!roster.isLoading && !roster.error && !candidates.length && !missing.length ? <p>{t("delegation.no_targets")}</p> : null}
      {[...candidates.map((target) => ({ id: target.id, name: target.displayName })), ...missing.map((id) => ({ id, name: t("delegation.unavailable_target") }))].map((target) => (
        <label key={target.id} className="agent-delegation-option">
          <Checkbox checked={selected.includes(target.id)} disabled={saving || !editable || (!selected.includes(target.id) && selected.length >= 20)}
            onCheckedChange={(checked) => void toggle(target.id, checked)} />
          <span>{target.name}</span>
        </label>
      ))}
      {error ? <Alert variant="boxed" role="alert">{error}</Alert> : null}
    </fieldset>
  );
}
