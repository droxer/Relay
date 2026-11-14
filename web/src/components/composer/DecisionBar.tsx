import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserAgent } from "../../types";
import { isUserAgentRoutable, visualAvailabilityOf } from "../../lib/agentDisplayNames";
import { RosterAgentItem, RosterOption, RosterTriggerValue } from "../roster/RosterOption";
import { StateMark } from "../StateMark";
import { availabilityPipTone } from "./availabilityTone";
import { ActionHandoff, ActionSend, ICON, NavMore } from "../icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHandoffStore } from "@/lib/handoffStore";

type DecisionAction = "approve" | "rerun" | "mark_done" | "handoff";

/** Something being written: the slip must not pull focus out of it. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';

/**
 * The decision a sent-back turn waits on, docked on the composer like every
 * other wait on a person and drawn like an approval: the two one-click
 * answers as rows, and "request changes" in the foot, because asking for
 * changes is a message written in the reply box under it. It only mounts
 * after a reject, so rejecting again is not offered. Rarer moves — closing
 * the work outright, handing it to another agent — sit in the menu.
 */
export function DecisionBar({ logicalAgents, sendDecision, sendHandoff, onRequestChanges }: {
  logicalAgents: UserAgent[];
  sendDecision: (kind: "approve" | "rerun" | "mark_done") => Promise<unknown>;
  sendHandoff: () => Promise<void>;
  /** Moves the caret to the reply box, where the change request is written. */
  onRequestChanges: () => void;
}) {
  const { t } = useTranslation();
  const handoffOpen = useHandoffStore((s) => s.open);
  const setHandoffOpen = useHandoffStore((s) => s.setOpen);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);

  // The slip mounts when a turn starts awaiting a decision. Focus its
  // heading, not a verb: a stray Enter must never decide, and a person
  // mid-sentence keeps the caret.
  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
    const focused = document.activeElement;
    const typing = focused instanceof Element && focused !== document.body && focused.closest(TYPING_TARGET);
    if (!typing) headingRef.current?.focus();
  }, []);

  const runAction = async (action: DecisionAction, run: () => Promise<unknown>) => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      await run();
    } finally {
      setPendingAction(null);
    }
  };

  const busy = pendingAction !== null;
  const choices = [
    { action: "rerun", label: t("decision.rerun"), effect: t("decision.rerun_effect") },
    { action: "approve", label: t("decision.accept"), effect: t("decision.accept_effect") },
  ] as const;

  return (
    <section className="composer-slip decision-slip" aria-labelledby={headingId}>
      <div className="composer-slip-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="composer-slip-title">{t("decision.title")}</h2>
      </div>
      {handoffOpen ? (
        <HandoffForm
          logicalAgents={logicalAgents}
          busy={busy}
          sending={pendingAction === "handoff"}
          onCancel={() => setHandoffOpen(false)}
          onSend={() => void runAction("handoff", sendHandoff)}
        />
      ) : (
        <>
          <ul className="awaiting-input-choices" aria-label={t("awaiting.choices")}>
            {choices.map((choice) => (
              <li key={choice.action}>
                <button
                  type="button"
                  className="awaiting-input-choice"
                  data-chosen={pendingAction === choice.action || undefined}
                  disabled={busy}
                  aria-busy={pendingAction === choice.action || undefined}
                  onClick={() => void runAction(choice.action, () => sendDecision(choice.action))}
                >
                  <span className="awaiting-input-choice-label">{choice.label}</span>
                  <span className="awaiting-input-choice-effect">{choice.effect}</span>
                  <ActionSend className="awaiting-input-choice-send" size={ICON.sm} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="composer-slip-foot">
            <div className="composer-slip-actions">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="icon" size="icon-dense" disabled={busy} aria-label={t("decision.more")} title={t("decision.more")}>
                      <NavMore size={ICON.md} aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void runAction("mark_done", () => sendDecision("mark_done"))}>
                    {t("decision.mark_done")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setHandoffOpen(true)}>
                    <ActionHandoff size={ICON.sm} aria-hidden="true" />
                    {t("decision.handoff")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="dense" type="button" disabled={busy} onClick={onRequestChanges}>{t("decision.request_changes")}</Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Handing the turn to another agent, in place of the answers. It asks the
 * same question the composer's target picker asks — which agent — so it
 * draws the same roster rows: identity mark, name, executor, and an
 * availability chip on anything that cannot take the round.
 */
function HandoffForm({ logicalAgents, busy, sending, onCancel, onSend }: {
  logicalAgents: UserAgent[];
  busy: boolean;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const handoffAgentId = useHandoffStore((s) => s.agentId);
  const setHandoffAgentId = useHandoffStore((s) => s.setAgentId);
  const handoffNote = useHandoffStore((s) => s.note);
  const setHandoffNote = useHandoffStore((s) => s.setNote);
  const handoffAgent = logicalAgents.find((agent) => agent.id === handoffAgentId) ?? null;
  const agentOptions = logicalAgents.map((agent) => ({
    value: agent.id,
    label: `${agent.displayName} · ${agent.executorKind}`,
  }));
  return (
    <div id="handoff-panel" className="handoff-form" role="group" aria-label={t("handoff.title")}>
      {/* `items` resolves the trigger label before the popup first mounts;
          without it the trigger would show the raw agent id. */}
      <Select value={handoffAgentId} items={agentOptions} onValueChange={(value) => { if (value != null) setHandoffAgentId(value); }}>
        <SelectTrigger id="handoff-agent" name="handoff-agent" className="w-full" aria-label={t("handoff.route_to")}>
          {handoffAgent ? <RosterTriggerValue agent={handoffAgent} /> : <SelectValue />}
        </SelectTrigger>
        <SelectContent>
          {logicalAgents.map((agent) => {
            const isRoutable = isUserAgentRoutable(agent);
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
      <Input
        id="handoff-note"
        name="handoff-note"
        autoComplete="off"
        aria-label={t("handoff.note_label")}
        placeholder={t("handoff.note_placeholder")}
        value={handoffNote}
        onChange={(e) => setHandoffNote(e.target.value)}
        // Inside the composer's form: Enter must not send the reply box.
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault(); }}
      />
      <div className="composer-slip-foot">
        <div className="composer-slip-actions">
          <Button variant="ghost" size="dense" type="button" disabled={busy} onClick={onCancel}>{t("handoff.cancel")}</Button>
          <Button variant="default" size="dense" type="button" disabled={busy} loading={sending} loadingLabel={t("decision.pending")} onClick={onSend}>{t("handoff.send")}</Button>
        </div>
      </div>
    </div>
  );
}
