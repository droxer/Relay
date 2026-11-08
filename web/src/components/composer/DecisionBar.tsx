import { ThreadPrompt } from "../ThreadPrompt";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserAgent } from "../../types";
import { isUserAgentRoutable, visualAvailabilityOf } from "../../lib/agentDisplayNames";
import { RosterAgentItem, RosterOption, RosterTriggerValue } from "../roster/RosterOption";
import { StateMark } from "../StateMark";
import { availabilityPipTone } from "./availabilityTone";
import {
  ActionApprove,
  ActionHandoff,
  ActionRoute,
  ICON,
  NavMore,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHandoffStore } from "@/lib/handoffStore";

type DecisionAction = "approve" | "rerun" | "mark_done" | "handoff";

/** Something being written: the card must not pull focus out of it. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]';

/**
 * The decision a sent-back turn waits on. It only mounts after a reject, so
 * rejecting again is not offered: the person either says what to change (the
 * reply box), runs the turn again, or accepts it after all. Rarer moves —
 * closing the work outright, handing it to another agent — sit in the menu so
 * no more than three verbs compete for one decision.
 */
export function DecisionBar({ logicalAgents, sendDecision, sendHandoff, onRequestChanges, deferPrimary = false }: {
  logicalAgents: UserAgent[];
  sendDecision: (kind: "approve" | "rerun" | "mark_done") => Promise<unknown>;
  sendHandoff: () => Promise<void>;
  /** Moves the caret to the reply box, where the change request is written. */
  onRequestChanges: () => void;
  /** Set while a permission prompt above holds the view's primary action. */
  deferPrimary?: boolean;
}) {
  const { t } = useTranslation();
  const handoffOpen = useHandoffStore((s) => s.open);
  const setHandoffOpen = useHandoffStore((s) => s.setOpen);
  const handoffAgentId = useHandoffStore((s) => s.agentId);
  const setHandoffAgentId = useHandoffStore((s) => s.setAgentId);
  const handoffNote = useHandoffStore((s) => s.note);
  const setHandoffNote = useHandoffStore((s) => s.setNote);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
  const pendingLabel = t("decision.pending");

  // The card mounts when a turn starts awaiting a decision. Focus its heading,
  // not a verb: a stray Enter must never decide, and a person mid-sentence
  // keeps the caret.
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
    <ThreadPrompt title={t("decision.title")}>
      <section className="decision-card" aria-labelledby={headingId}>
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className="decision-card-title">{t("decision.title")}</h3>
        <p className="decision-card-hint">{t("decision.hint")}</p>
        <div className="decision-bar">
          {/* One accent fill per view: while the handoff panel is open its Send
              is the action in hand, and while a permission prompt is open its
              Allow is, so Request changes steps down to the outline tier. */}
          <Button variant={handoffOpen || deferPrimary ? "outline" : "default"} type="button" disabled={busy} onClick={onRequestChanges}>{t("decision.request_changes")}</Button>
          <Button variant="outline" type="button" disabled={busy} loading={pendingAction === "rerun"} loadingLabel={pendingLabel} onClick={() => void runAction("rerun", () => sendDecision("rerun"))}>{t("decision.rerun")}</Button>
          <Button variant="ghost" type="button" disabled={busy} loading={pendingAction === "approve"} loadingLabel={pendingLabel} onClick={() => void runAction("approve", () => sendDecision("approve"))}><ActionApprove size={ICON.sm} /> {t("decision.accept")}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="icon" size="icon" disabled={busy} aria-label={t("decision.more")} title={t("decision.more")}>
                  <NavMore size={ICON.md} aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void runAction("mark_done", () => sendDecision("mark_done"))}>
                {t("decision.mark_done")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHandoffOpen(!handoffOpen)}>
                <ActionHandoff size={ICON.sm} aria-hidden="true" />
                {t("decision.handoff")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>
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
    </ThreadPrompt>
  );
}
