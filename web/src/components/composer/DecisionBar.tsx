import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EmployeeAgent } from "../../types";
import { isEmployeeAgentRoutable, visualAvailabilityOf } from "../../lib/agentDisplayNames";
import { RosterAgentItem, RosterOption, RosterTriggerValue } from "../roster/RosterOption";
import { StateMark } from "../StateMark";
import { availabilityPipTone } from "./availabilityTone";
import {
  ActionApprove,
  ActionHandoff,
  ActionRoute,
  ICON,
} from "../icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDialogs } from "@/components/ui/DialogProvider";

type DecisionAction = "approve" | "reject" | "rerun" | "mark_done" | "handoff";

export function DecisionBar({ logicalAgents, sendDecision, handoffOpen, setHandoffOpen, handoffAgentId, setHandoffAgentId, handoffNote, setHandoffNote, sendHandoff }: {
  logicalAgents: EmployeeAgent[];
  sendDecision: (kind: "approve" | "reject" | "rerun" | "mark_done") => Promise<void>;
  handoffOpen: boolean; setHandoffOpen: (v: boolean) => void;
  handoffAgentId: string; setHandoffAgentId: (id: string) => void;
  handoffNote: string; setHandoffNote: (v: string) => void;
  sendHandoff: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const approveRef = useRef<HTMLButtonElement>(null);
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
  const pendingLabel = t("decision.pending", { defaultValue: "Working…" });

  // The bar mounts when a turn starts awaiting a decision; move keyboard and
  // screen-reader focus to its primary action so it is not missed.
  useEffect(() => {
    approveRef.current?.focus();
  }, []);

  const runAction = async (action: DecisionAction, run: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      await run();
    } finally {
      setPendingAction(null);
    }
  };

  // Reject discards the turn, so it confirms first — approve/rerun/mark_done
  // stay one-click since they are recoverable.
  const handleReject = async () => {
    if (pendingAction) return;
    const ok = await confirm({
      title: t("decision.reject_confirm_title"),
      message: t("decision.reject_confirm_message"),
      confirmLabel: t("decision.reject"),
      tone: "danger",
    });
    if (!ok) return;
    await runAction("reject", () => sendDecision("reject"));
  };

  const busy = pendingAction !== null;

  // Handing off is the same question the composer's target picker asks — which
  // agent — so it draws the same roster rows: identity mark, name, executor,
  // and an availability chip on anything that cannot take the round. It used
  // to be plain text with "(disabled)" appended to the name, which is the one
  // spelling of "an agent" this app is meant not to have.
  const handoffAgent = logicalAgents.find((agent) => agent.id === handoffAgentId) ?? null;
  const agentOptions = logicalAgents.map((agent) => ({
    value: agent.id,
    label: `${agent.displayName} · ${agent.executorKind}`,
  }));

  return (
    <>
      <div className="decision-bar">
        <Button variant="default" type="button" ref={approveRef} disabled={busy} loading={pendingAction === "approve"} loadingLabel={pendingLabel} onClick={() => void runAction("approve", () => sendDecision("approve"))}><ActionApprove size={ICON.sm} /> {t("decision.approve")}</Button>
        <Button variant="ghost" type="button" disabled={busy} loading={pendingAction === "rerun"} loadingLabel={pendingLabel} onClick={() => void runAction("rerun", () => sendDecision("rerun"))}>{t("decision.rerun")}</Button>
        <Button variant="ghost" type="button" disabled={busy} loading={pendingAction === "mark_done"} loadingLabel={pendingLabel} onClick={() => void runAction("mark_done", () => sendDecision("mark_done"))}>{t("decision.mark_done")}</Button>
        <Button variant="destructive" type="button" disabled={busy} loading={pendingAction === "reject"} loadingLabel={pendingLabel} onClick={() => void handleReject()}>{t("decision.reject")}</Button>
        <Button variant="ghost" type="button" disabled={busy} aria-controls={handoffOpen ? "handoff-panel" : undefined} aria-expanded={handoffOpen} onClick={() => setHandoffOpen(!handoffOpen)}>
          <ActionHandoff size={ICON.sm} /> {t("decision.handoff")}
        </Button>
      </div>
      {handoffOpen ? (
        <div id="handoff-panel" className="handoff-panel">
          <div className="handoff-panel-head">
            <span className="handoff-panel-mark" aria-hidden="true"><ActionRoute size={ICON.sm} /></span>
            <span className="handoff-panel-title">{t("handoff.title")}</span>
          </div>
          <div className="handoff-row">
            <Label htmlFor="handoff-agent">{t("handoff.route_to")}</Label>
            {/* `items` resolves the trigger label before the popup first mounts;
                without it the trigger would show the raw agent id. */}
            <Select value={handoffAgentId} items={agentOptions} onValueChange={(value) => { if (value != null) setHandoffAgentId(value); }}>
              <SelectTrigger id="handoff-agent" name="handoff-agent" className="w-full">
                {handoffAgent ? <RosterTriggerValue agent={handoffAgent} /> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                {logicalAgents.map((agent) => {
                  const isRoutable = isEmployeeAgentRoutable(agent);
                  const availability = visualAvailabilityOf(agent);
                  return (
                    <RosterAgentItem
                      key={agent.id}
                      value={agent.id}
                      agent={agent}
                      className="chat-agent-option"
                      disabled={!isRoutable}
                      data-availability={availability}
                    >
                      <RosterOption agent={agent} />
                      {isRoutable ? null : (
                        <span className="chat-agent-option-availability" data-availability={availability}>
                          <StateMark tone={availabilityPipTone(availability)} />
                          {t(`status.${availability}`, { defaultValue: availability })}
                        </span>
                      )}
                    </RosterAgentItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="handoff-row handoff-row--note">
            <Label htmlFor="handoff-note">{t("handoff.note_label")}</Label>
            <Input id="handoff-note" name="handoff-note" autoComplete="off" placeholder={t("handoff.note_placeholder")} value={handoffNote} onChange={(e) => setHandoffNote(e.target.value)} />
          </div>
          <div className="handoff-actions">
            <Button variant="ghost" type="button" disabled={busy} onClick={() => setHandoffOpen(false)}>{t("handoff.cancel")}</Button>
            <Button variant="default" type="button" disabled={busy} loading={pendingAction === "handoff"} loadingLabel={pendingLabel} onClick={() => void runAction("handoff", sendHandoff)}>{t("handoff.send")}</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
