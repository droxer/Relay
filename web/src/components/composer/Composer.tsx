import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTeam, DaemonNodeMonitorRecord, EmployeeAgent } from "../../types";
import { sendShortcutLabel } from "../../lib/sendShortcut";
import {
  ActionSend,
  ComposerStop,
  ICON,
  WorkspaceFolder,
} from "../icons";
import { AgentSelect } from "./AgentSelect";
import { useComposer } from "../../hooks/useComposer";
import { useMentionAutocomplete } from "../../hooks/useMentionAutocomplete";
import { parseMentions, replaceAddressRun, type MentionCandidate } from "../../lib/mentions";
import { MentionHighlight } from "./MentionHighlight";
import { Button } from "@/components/ui/button";
import { MENTION_LIST_ID, MentionPopup, mentionOptionId } from "./MentionPopup";
import { ThreadRuntimeReadout, ThreadRuntimeSelect } from "./ThreadRuntimeSelect";
import { Textarea } from "@/components/ui/textarea";


export type ComposerHandle = {
  clear: () => void;
  focus: () => void;
  getText: () => string;
  /** Put text back in the box — used to return a message a failed send ate. */
  setText: (text: string) => void;
};

// Message composer: textarea, agent control, and the send/cancel
// control. Draft state stays inside this component so every
// keystroke does not re-render the full application shell and transcript.
const ComposerView = forwardRef<ComposerHandle, {
  logicalAgents: EmployeeAgent[];
  activeLogicalAgentId: string | null;
  onLogicalAgentPicked: (agent: EmployeeAgent) => void;
  /** Teams offered while staging a new thread; empty for a started one. */
  teams?: AgentTeam[];
  /** The picked team, or the team a started thread belongs to. */
  activeTeamId?: string | null;
  onTeamPicked?: (team: AgentTeam) => void;
  /** A started team thread keeps its team for life — the picker locks. */
  teamLocked?: boolean;
  activeAgentDisplayName: string;
  selectedEmployee: string;
  initializingThread: boolean;
  /** A project room owns its Computer and roster, so neither is editable here. */
  projectName?: string;
  /** The project's roster as one target: the round runs every member. */
  projectRoom?: { memberCount: number } | null;
  projectRoomSelected?: boolean;
  onProjectRoomPicked?: () => void;
  /** Archived or disabled projects remain readable but cannot start another round. */
  readOnly?: boolean;
  runtimeNodes: DaemonNodeMonitorRecord[];
  runtimeNodeId: string | null;
  /** The picked computer resolved against the whole fleet, not just the
   *  currently-selectable subset. */
  selectedRuntimeNode: DaemonNodeMonitorRecord | null;
  /** The computer an already-started thread is pinned to, shown read-only. */
  activeRuntimeNode: DaemonNodeMonitorRecord | null;
  onRuntimeNodeChange: (nodeId: string) => void;
  running: boolean;
  /** Agents `@` may name in this thread — the ones on its computer. Empty
   *  while staging a new thread, where the footer picker chooses the target. */
  mentionCandidates?: MentionCandidate[];
  onSend: () => void;
  onCancelRun: () => void;
}>(function Composer({ logicalAgents, activeLogicalAgentId, onLogicalAgentPicked, teams, activeTeamId, onTeamPicked, teamLocked, activeAgentDisplayName, selectedEmployee, initializingThread, projectName, projectRoom = null, projectRoomSelected = false, onProjectRoomPicked, readOnly = false, runtimeNodes, runtimeNodeId, selectedRuntimeNode, activeRuntimeNode, onRuntimeNodeChange, running, mentionCandidates = [], onSend, onCancelRun }, ref) {
  const { t } = useTranslation();
  const composer = useComposer();
  const {
    composerText, setComposerText, textareaRef,
  } = composer;
  // Derived every render rather than stored: the draft text is the only
  // source of truth for who this message addresses.
  const parsed = useMemo(
    () => parseMentions(composerText, mentionCandidates),
    [composerText, mentionCandidates],
  );
  // A mention is a selection: while the draft addresses someone, the footer
  // names that agent rather than the picker's standing choice, so the composer
  // gives one answer to "who runs this?" instead of two. A team thread is the
  // exception — the round still runs the whole roster, so it keeps naming the
  // team.
  const addressedLogicalAgentId = activeTeamId
    ? null
    : parsed.addressAgentIds[0] ?? null;
  // A mention names one member, so it narrows a project round away from the
  // roster exactly the way picking that member in the footer would.
  const roomSelected = projectRoomSelected && !addressedLogicalAgentId;
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const mentions = useMentionAutocomplete({
    text: composerText,
    candidates: mentionCandidates,
    setText: setComposerText,
    textareaRef,
  });
  // The footer picker and `@` are one selection, so picking in the footer
  // rewrites the draft's address run instead of losing to it at dispatch — a
  // leading mention outranks the picker when the message is sent.
  const pickLogicalAgent = (agent: EmployeeAgent) => {
    if (parsed.mentions.length > 0) {
      setComposerText(replaceAddressRun(composerText, parsed.mentions, agent.displayName));
      textareaRef.current?.focus();
    }
    onLogicalAgentPicked(agent);
  };
  // Picking a team addresses the whole roster, so a leftover mention naming one
  // agent would quietly narrow the round back down to them.
  const dropMentions = () => {
    if (parsed.mentions.length === 0) return;
    const start = parsed.mentions[0].start;
    const end = parsed.mentions[parsed.mentions.length - 1].end;
    setComposerText(`${composerText.slice(0, start)}${composerText.slice(end).trimStart()}`);
  };
  const pickTeam = (team: AgentTeam) => {
    dropMentions();
    onTeamPicked?.(team);
  };
  // Same reason as a team: a leftover mention would quietly narrow a round the
  // author just aimed at the whole project roster.
  const pickRoom = () => {
    dropMentions();
    onProjectRoomPicked?.();
  };
  const sendShortcutTitle = useMemo(
    () => t("composer.send_shortcut", { shortcut: sendShortcutLabel() }),
    [t],
  );

  // Interim state between submit and the run actually starting, so the send
  // button can't double-fire while the dispatch is still being validated.
  const [sendPending, setSendPending] = useState(false);
  // One answer to "can this draft be sent?", read by both the button's
  // `disabled` and the keyboard path. They were written separately and had
  // already drifted: the button also refused a staged thread with no computer
  // picked, but `triggerSend` did not, so ⌘-Enter dispatched a round with no
  // runtime — the very bypass the mention comment below was added to close.
  const cannotSend = readOnly
    || !composerText.trim()
    || parsed.blocked
    || (initializingThread && !projectName && !runtimeNodeId);
  const triggerSend = () => {
    if (running || sendPending) return;
    // The send button is disabled on a mention that resolves to nobody, and on
    // a staged thread with no computer, but the keyboard shortcut bypasses the
    // button — a blocked draft sent anyway would address the whole room instead
    // of the agent the author named, and one with no computer has nowhere to run.
    if (cannotSend) return;
    setSendPending(true);
    onSend();
  };
  useEffect(() => {
    if (!sendPending) return;
    if (running) {
      setSendPending(false);
      return;
    }
    // The run starting clears pending; if dispatch failed upstream (validation,
    // error toast) `running` never flips, so fall back to a timeout instead of
    // leaving the send button stuck disabled.
    const timer = setTimeout(() => setSendPending(false), 4000);
    return () => clearTimeout(timer);
  }, [sendPending, running]);

  useImperativeHandle(ref, () => ({
    clear: () => setComposerText(""),
    focus: () => textareaRef.current?.focus(),
    getText: () => composerText,
    setText: (text: string) => setComposerText(text),
  }), [composerText, setComposerText, textareaRef]);

  // A project room owns its computer and its workspace, so the room names
  // itself here instead of offering a machine; a thread that has started names
  // the computer it was pinned to; only a thread still being staged gets a
  // picker.
  const computerSlot = projectName ? (
    <span className="composer-project-room" title={t("project.shared_workspace")}>
      <WorkspaceFolder size={ICON.sm} aria-hidden="true" />
      {projectName}
    </span>
  ) : initializingThread ? (
    <ThreadRuntimeSelect
      nodes={runtimeNodes}
      value={runtimeNodeId}
      selectedNode={selectedRuntimeNode}
      onValueChange={onRuntimeNodeChange}
    />
  ) : activeRuntimeNode ? (
    <ThreadRuntimeReadout node={activeRuntimeNode} />
  ) : null;

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); triggerSend(); }}>
      {/* Targets rail: who runs this round, and on which computer. It sits
          above the input card rather than in its footer so both answers read
          before the draft, and the card below is left to the draft and its one
          commit control.

          The two are not peers. A thread is pinned to its computer the moment
          it starts — the workspace belongs to the thread — while the agent
          stays switchable for the thread's whole life, because every agent on
          that computer shares that workspace. So the rail leads with whichever
          one the author can still act on: the computer picker while staging
          (it gates which agents exist at all), the agent picker afterwards,
          with the settled computer trailing it as quiet context. */}
      <div className="composer-targets">
        {initializingThread ? computerSlot : null}
        <AgentSelect
          logicalAgents={logicalAgents}
          activeLogicalAgentId={addressedLogicalAgentId ?? activeLogicalAgentId}
          onLogicalAgentPicked={pickLogicalAgent}
          teams={projectName ? [] : teams}
          activeTeamId={projectName ? null : activeTeamId}
          onTeamPicked={pickTeam}
          teamLocked={teamLocked}
          teamOptionsEnabled={initializingThread && !projectName}
          room={projectName ? projectRoom : null}
          roomSelected={roomSelected}
          onRoomPicked={pickRoom}
          running={running}
        />
        {initializingThread ? null : computerSlot}
      </div>
      <div className="composer-input-wrap" data-running={running || undefined}>
        <div className="composer-input">
          <MentionPopup
            matches={mentions.matches}
            activeIndex={mentions.activeIndex}
            onHover={mentions.setActiveIndex}
            onPick={mentions.pick}
          />
          {/* The mirror sits under the textarea inside a positioned wrapper so
              the pills track the text through resize and scroll. */}
          <div className="composer-textarea-wrap">
            <MentionHighlight ref={highlightRef} text={composerText} mentions={parsed.mentions} />
            {/* The shared Textarea, with the composer's own geometry on top:
                this field is one of two grid-stacked layers (the other is the
                mention mirror) and the two must break text identically, so the
                padding, font, and wrapping come from `.composer-textarea`
                rather than the primitive's defaults. Going through the
                primitive anyway keeps every multi-line field in the app one
                component, and lets the CSS stop reaching through a tag name. */}
            <Textarea
              ref={textareaRef}
              className="composer-textarea"
              aria-label={selectedEmployee
                ? t("composer.aria_label", { employee: selectedEmployee, agent: activeAgentDisplayName })
                : t("composer.aria_label_no_employee", { agent: activeAgentDisplayName })}
              autoComplete="off"
              disabled={readOnly}
              // While `@` is open the textarea drives the list from the
              // keyboard, so a screen reader has to hear the moving highlight.
              role={mentions.matches.length > 0 ? "combobox" : undefined}
              aria-expanded={mentions.matches.length > 0 || undefined}
              aria-controls={mentions.matches.length > 0 ? MENTION_LIST_ID : undefined}
              aria-autocomplete={mentions.matches.length > 0 ? "list" : undefined}
              aria-activedescendant={mentions.matches.length > 0
                ? mentionOptionId(mentions.matches[mentions.activeIndex].id)
                : undefined}
              name="message"
              placeholder={selectedEmployee
                ? t("composer.placeholder")
                : t("composer.placeholder_no_employee")}
              value={composerText}
              onChange={(e) => {
                setComposerText(e.target.value);
                mentions.onCaretChange(e.target.selectionStart ?? e.target.value.length);
              }}
              onSelect={(e) => mentions.onCaretChange(e.currentTarget.selectionStart ?? 0)}
              onBlur={mentions.close}
              onKeyDown={(e) => {
                // The popup gets first refusal on navigation keys; the send
                // shortcut is untouched because the popup never claims it.
                if (!(e.metaKey || e.ctrlKey) && mentions.handleKey(e.key)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); triggerSend(); }
              }}
              onScroll={(e) => {
                // A tall draft scrolls inside the textarea; the mirror has to
                // follow or the pills detach from their names.
                if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              rows={1}
            />
          </div>
          <div className="composer-footer">
            {/* One mounted element for send↔stop so keyboard focus survives
                the run starting; the glyph cross-fades instead. */}
            {/* Button's default size carries h-(--control-h) and px-6, which
                would stretch the plate into a wide oval; the size overrides
                ride the same className so tailwind-merge drops the defaults
                and the documented control-h-sm disc survives. */}
            <Button variant="default"
              type={running ? "button" : "submit"}
              className={running
                ? "send-button send-button-cancel h-(--control-h-sm) w-(--control-h-sm) px-0"
                : "send-button h-(--control-h-sm) w-(--control-h-sm) px-0"}
              disabled={!running && (sendPending || cannotSend)}
              onClick={running ? onCancelRun : undefined}
              aria-busy={sendPending || undefined}
              aria-label={running ? t("composer.cancel_run") : sendPending ? t("composer.sending", { defaultValue: "Sending…" }) : t("composer.send")}
              tooltip={running
                ? t("composer.cancel_run")
                : parsed.blocked
                  ? t("composer.mention_blocked")
                  : sendShortcutTitle}
            >
              <span className="send-button-icon" key={running ? "stop" : "send"}>
                {running ? <ComposerStop size={ICON.sm} /> : <ActionSend size={ICON.md} />}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
});

export const Composer = memo(ComposerView);
