import {
  ActionCopy,
  CheckIcon,
  ICON,
  StreamAttachment,
} from "./icons";
import { relayApiEndpoint } from "../lib/apiOrigin";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AgentMark } from "./AgentMark";
import { AgentStream } from "./AgentStream";
import { AttachmentMarker } from "./AttachmentMarker";
import { MarkdownContent } from "./LazyMarkdown";
import { MarkdownFileLinks } from "./markdown/context";
import type { ResolveThreadFileLink } from "../lib/threadFileLinks";
import { AutomationOpening } from "./AutomationOpening";
import type { AutomationOpening as AutomationOpeningParts } from "../lib/automationOpening";
import { MessageTurnActions } from "./MessageTurnActions";
import type { AgentName } from "../types";
import { AGENT_NAMES } from "../types";
import { imageForAgentRun, labelForExecutor } from "../lib/agentDisplayNames";
import { AgentRoleMeta } from "./RoleLevelBadge";
import { extractLeadingMentionTokens } from "../lib/mentions";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { runReceipt } from "../lib/runReceipt";
import { RunReceipt } from "./RunReceipt";
import { parsePlanSteps, type PlanStep } from "../lib/plan";
import type { AgentRun, RelayArtifact } from "relay-core";
import { useArtifactBody } from "../lib/useArtifactBody";
import { summarizeArtifact } from "../lib/artifactStats";
import type { DerivedMessage } from "../lib/projectMessages";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
export { isGroupedContinuation, projectMessages } from "../lib/projectMessages";
export type { DerivedMessage } from "../lib/projectMessages";

function formatTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  // A malformed event timestamp must not throw mid-render and take the whole
  // transcript down with it.
  if (Number.isNaN(date.getTime())) return "";
  // Minutes, not seconds: a turn is a unit of conversation, and the second
  // hand adds three characters of noise to every row without ever being the
  // thing a reader wants. The full instant stays on the <time dateTime>.
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// A malformed timestamp formats to "", so render no <time> at all rather than
// an empty element with a bogus dateTime.
function MsgTime({ value }: { value: string }) {
  const { i18n } = useTranslation();
  const formatted = useMemo(() => formatTime(value, i18n.language || undefined), [value, i18n.language]);
  if (!formatted) return null;
  return <time className="msg-time tnum" dateTime={value}>{formatted}</time>;
}

function UserMessageCopy({ text }: { text: string }) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      announce({ message: t("errors.copy_message"), tone: "error" });
    }
  }, [text, t, announce]);

  if (!text.trim()) return null;

  return (
    <>
      <span className="sr-only" role="status">{copied ? t("message.copied") : ""}</span>
      <Button
        variant="ghost"
        type="button"
        className={`msg-turn-action ${copied ? "is-copied" : ""}`}
        onClick={() => void handleCopy()}
        tooltip={copied ? t("message.copied") : t("message.copy")}
      >
        {copied ? <CheckIcon size={ICON.sm} /> : <ActionCopy size={ICON.sm} />}
        <span className="msg-turn-action-label">{copied ? t("message.copied") : t("message.copy")}</span>
      </Button>
    </>
  );
}

function formatArtifactSize(bytes: number | undefined, t: TFunction, locale: string | undefined): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return t("artifact.size_unknown");
  const units = [
    { key: "mb", value: 1024 * 1024 },
    { key: "kb", value: 1024 },
  ] as const;
  const unit = units.find((item) => bytes >= item.value);
  if (unit) {
    const value = new Intl.NumberFormat(locale, {
      maximumFractionDigits: bytes >= unit.value * 10 ? 0 : 1,
    }).format(bytes / unit.value);
    return t(`artifact.size_${unit.key}`, { count: value });
  }
  return t("artifact.size_bytes", {
    count: new Intl.NumberFormat(locale).format(bytes),
  });
}

function PlanSummary({ steps, agentDisplayNames }: { steps: PlanStep[]; agentDisplayNames?: Partial<Record<AgentName, string>> }) {
  return (
    <ol className="artifact-plan-summary">
      {steps.map((step, index) => (
        <li key={`${step.agent}-${index}`} className="artifact-plan-item">
          {index > 0 ? <span className="artifact-plan-arrow" aria-hidden="true">→</span> : null}
          <span className="artifact-plan-step">
            <AgentMark agent={step.agent} size={ICON.sm} />
            <span className="artifact-plan-agent">{labelForExecutor(step.agent, agentDisplayNames)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// Plan artifacts render inline as a human-readable step summary; they carry a
// short JSON assignment list rather than a body worth opening in the viewer.
function PlanCard({ artifact, sessionId, agentDisplayNames }: { artifact: RelayArtifact; sessionId: string; agentDisplayNames?: Partial<Record<AgentName, string>> }) {
  const { t } = useTranslation();
  const body = useArtifactBody(sessionId, artifact.id);
  const planSteps = body.isSuccess ? parsePlanSteps(body.data ?? "", AGENT_NAMES) : null;

  // Until the body resolves, render a compact placeholder so the common
  // single-step case never flashes wider chrome.
  if (!planSteps) {
    return (
      <div className="artifact-plan-note artifact-plan-note-loading">
        <span className="artifact-plan-note-label">{artifact.title}</span>
        <span className="workspace-skeleton artifact-plan-skeleton" aria-hidden="true" />
        <span className="sr-only" role="status">{t("artifact.plan_loading")}</span>
      </div>
    );
  }
  return (
    <div className="artifact-plan-note">
      <span className="artifact-plan-note-label">{artifact.title}</span>
      <PlanSummary steps={planSteps} agentDisplayNames={agentDisplayNames} />
    </div>
  );
}

function ArtifactCard({ artifact, sessionId, onOpenArtifact, agentDisplayNames }: { artifact: RelayArtifact; sessionId: string; onOpenArtifact?: (artifact: RelayArtifact) => void; agentDisplayNames?: Partial<Record<AgentName, string>> }) {
  if (artifact.kind === "plan") {
    return <PlanCard artifact={artifact} sessionId={sessionId} agentDisplayNames={agentDisplayNames} />;
  }
  return <ArtifactChip artifact={artifact} sessionId={sessionId} onOpenArtifact={onOpenArtifact} />;
}

const ARTIFACT_STAT_MAX_BYTES = 256 * 1024;

function ArtifactChip({ artifact, sessionId, onOpenArtifact }: { artifact: RelayArtifact; sessionId: string; onOpenArtifact?: (artifact: RelayArtifact) => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || undefined;
  // The file viewer owns the request. A chip can derive a stat once its
  // body has already been opened and cached.
  const body = useArtifactBody(sessionId, artifact.id, { enabled: false });
  const stat = artifact.kind !== "workspace_file" && body.isSuccess && body.data.length <= ARTIFACT_STAT_MAX_BYTES
    ? summarizeArtifact(artifact.kind, body.data) : null;
  const kindLabel = t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind });
  return (
    <article className="artifact-chip" data-kind={artifact.kind}>
      <Button variant="ghost"
        type="button"
        className="artifact-chip-main"
        onClick={() => onOpenArtifact?.(artifact)}
        aria-label={t("artifact.view_named", { title: artifact.title })}
      >
        <span className="artifact-chip-icon" aria-hidden="true">
          <StreamAttachment size={ICON.sm} />
        </span>
        <span className="artifact-chip-copy">
          <span className="artifact-chip-kicker">
            <span className={`artifact-kind-tag is-${artifact.kind}`}>{kindLabel}</span>
            {stat ? (
              <span className={`artifact-stat tnum tone-${stat.tone}`}>{t(`artifact.stat.${stat.key}`, stat.vars)}</span>
            ) : (
              <span className="artifact-stat tnum tone-neutral">{formatArtifactSize(artifact.bytes, t, locale)}</span>
            )}
          </span>
          <strong>{artifact.title}</strong>
        </span>
      </Button>
    </article>
  );
}

type MessageBlockProps = {
  slotLabel?: string;
  runIdentity?: Pick<AgentRun, "role" | "roleLevel" | "runtimeSessionId">;
  styleFallback?: boolean;
  message: DerivedMessage;
  /** Set on an automation run's opening turn: it draws as the automation's
   * card instead of a message the user typed. */
  automationOpening?: AutomationOpeningParts | null;
  sessionId: string;
  grouped?: boolean;
  agentDisplayNames?: Partial<Record<AgentName, string>>;
  /** Display name per logical agent id, so a turn is attributed to the agent
   * that ran it rather than to whichever agent shares its executor kind. */
  logicalAgentNames?: Record<string, string>;
  /** Uploaded profile image per logical agent id; agents without one fall
   * back to the name monogram, so this map only carries the exceptions. */
  logicalAgentImages?: Record<string, string>;
  onOpenArtifact?: (artifact: RelayArtifact) => void;
  resolveFileLink?: ResolveThreadFileLink;
  onRetryAgent?: (agent: AgentName, agentId?: string) => void;
  onResumeAgent?: (agent: AgentName, agentId?: string) => void;
  onMentionAgent?: (displayName: string) => void;
  mentionableAgentIds?: ReadonlySet<string>;
  retryDisabled?: boolean;
  /** Name of the teammate this turn takes over from, when it is a handoff.
   * Until the first output lands the turn says so instead of "Working…". */
  pickupFrom?: string;
};

export const MessageBlock = memo(function MessageBlock({
  slotLabel,
  runIdentity,
  styleFallback,
  message,
  automationOpening,
  sessionId,
  grouped = false,
  agentDisplayNames,
  logicalAgentNames,
  logicalAgentImages,
  onOpenArtifact,
  resolveFileLink,
  onRetryAgent,
  onResumeAgent,
  onMentionAgent,
  mentionableAgentIds,
  retryDisabled = false,
  pickupFrom,
}: MessageBlockProps) {
  const { t } = useTranslation();
  const fileLinkRunId = message.kind === "agent" && !message.streaming ? message.runId : undefined;
  const codexSessionId = message.kind === "agent" && message.agent === "codex" ? runIdentity?.runtimeSessionId : undefined;
  const fileLinks = useMemo(() => {
    if (!fileLinkRunId || !resolveFileLink || !onOpenArtifact) return null;
    return {
      resolve: (href: string) => resolveFileLink(href, fileLinkRunId, codexSessionId),
      open: onOpenArtifact,
    };
  }, [fileLinkRunId, codexSessionId, onOpenArtifact, resolveFileLink]);
  const mentionNames = useMemo(() => {
    if (!logicalAgentNames) return undefined;
    const names = Object.values(logicalAgentNames);
    return names.length > 0 ? names : undefined;
  }, [logicalAgentNames]);
  const mentionableNames = useMemo(() => {
    if (!onMentionAgent || !logicalAgentNames || !mentionableAgentIds?.size) return undefined;
    const map = new Map<string, string>();
    for (const id of mentionableAgentIds) {
      const name = logicalAgentNames[id];
      if (name) map.set(name.toLowerCase(), name);
    }
    return map.size > 0 ? map : undefined;
  }, [onMentionAgent, logicalAgentNames, mentionableAgentIds]);
  const leadingMentions = useMemo(() => {
    if (message.kind !== "user" || !mentionNames) return undefined;
    const tokens = extractLeadingMentionTokens(message.text, mentionNames);
    return tokens.length > 0 ? tokens : undefined;
  }, [message, mentionNames]);
  if (message.kind === "user" && automationOpening) {
    return <AutomationOpening opening={automationOpening} time={<MsgTime value={message.timestamp} />} />;
  }

  if (message.kind === "user") {
    return (
      // The user's turn sits on the right as a bubble with no avatar — the
      // side, not a face, says who is speaking (the shape every current chat
      // surface converged on). The timestamp and copy action resolve under it on hover.
      <article className="msg msg-user" aria-label={t("message.user_label")}>
        <div className="turn-body">
          {/* The user's own Markdown renders like the agent's: a pasted fence
              is a highlighted block, not a paragraph with backticks in it.
              Same escaped pipeline as the agent side — no raw HTML. */}
          <div className="user-text md-body agent-prose">
            <MarkdownContent
              text={message.text}
              leadingMentions={leadingMentions}
              mentionableNames={mentionableNames}
              onMentionClick={mentionableNames ? onMentionAgent : undefined}
            />
            {message.attachments?.length ? <div className="message-images">{message.attachments.map((image, index) => (
              <a key={image.id} href={relayApiEndpoint(`/thread-attachments/${encodeURIComponent(image.id)}`)} target="_blank" rel="noreferrer">
                <img src={relayApiEndpoint(`/thread-attachments/${encodeURIComponent(image.id)}`)} loading="lazy"
                  alt={t("composer.image_number", { defaultValue: "Attached image {{number}}", number: index + 1 })} />
              </a>
            ))}</div> : null}
          </div>
        </div>
        {message.live ? <p className="msg-user-note">{t("message.sent_live")}</p> : null}
        <div className="msg-user-foot">
          <UserMessageCopy text={message.text} />
          <MsgTime value={message.timestamp} />
        </div>
      </article>
    );
  }

  if (message.kind === "agent") {
    const logicalName = message.agentId ? logicalAgentNames?.[message.agentId] : undefined;
    const agentName = logicalName ?? t("backlog.agent");
    const roleIdentity = {
      defaultRole: message.role ?? runIdentity?.role,
      roleLevel: message.roleLevel ?? runIdentity?.roleLevel,
    };
    const receipt = runReceipt(message);
    return (
      <article
        className={`msg msg-agent ${message.streaming ? "streaming" : ""} ${grouped ? "grouped" : ""}`}
        aria-label={t("message.agent_header", { user: agentName })}
      >
        {/* Who is speaking: mark, name, and time on one header row, with the
            answer flush beneath it at the full column width. A continuation
            from the same agent hides the row (see .msg-agent.grouped in
            chat.css), so a run of turns reads as one speaker. */}
        <span className="rail-node rail-node-agent" aria-hidden="true">
          <ProfileImage
            src={imageForAgentRun(message, logicalAgentImages)}
            alt=""
            fallback={<IdentityMark kind="agent" />}
          />
        </span>
        <header className="msg-speaker">
          <span className="msg-speaker-name" translate={logicalName ? "no" : undefined}>{agentName}</span>
          <AgentRoleMeta identity={roleIdentity} />
          {slotLabel ? <span className="msg-speaker-slot">{t(slotLabel)}</span> : null}
        </header>
        <MsgTime value={message.timestamp} />
        <div className="turn-body">
          {styleFallback ? <p className="collab-status">{t("collab_style.ran_solo")}</p> : null}
          {/* Relay reran this step itself: say why, so the turn never reads
              as more of the answer finished above it. */}
          {message.followUp ? (
            <p className="collab-status">{t(`message.follow_up_${message.followUp}`, { agent: agentName })}</p>
          ) : null}
          <MarkdownFileLinks.Provider value={fileLinks}>
            <AgentStream
              agent={message.agent}
              stdout={message.stdout}
              stderr={message.stderr}
              streaming={message.streaming}
              collaborations={message.collaborations}
              permissions={message.permissions}
              mentionNames={mentionNames}
              mentionableNames={mentionableNames}
              onMentionClick={mentionableNames ? onMentionAgent : undefined}
              pickupFrom={pickupFrom}
            />
          </MarkdownFileLinks.Provider>
          {message.attachments.length > 0 ? (
            <div className="attachment-list">
              {message.attachments.filter((artifact) => artifact.kind === "plan").map((artifact) => (
                <PlanCard key={artifact.id} artifact={artifact} sessionId={sessionId} agentDisplayNames={agentDisplayNames} />
              ))}
              <AttachmentMarker
                artifacts={message.attachments.filter((artifact) => artifact.kind !== "plan")}
                sessionId={sessionId}
                onOpenArtifact={onOpenArtifact}
              />
            </div>
          ) : null}
          {message.outputTruncated && !message.streaming ? (
            <p className="msg-turn-note" role="note">{t("thread.output_truncated")}</p>
          ) : null}
          {receipt ? (
            <RunReceipt receipt={receipt} usage={message.tokenUsage} />
          ) : null}
          {/* Actions lead under the answer, where the eye ends; the run's
              cost and outcome live in the receipt above. A block a live
              message cut has none: the run's actions follow its last block. */}
          {message.continued ? null : <footer className="msg-turn-foot">
            <MessageTurnActions
              agent={message.agent}
              agentId={message.agentId}
              agentName={logicalName}
              stdout={message.stdout}
              stderr={message.stderr}
              streaming={message.streaming}
              retryDisabled={retryDisabled}
              onRetry={onRetryAgent}
              onMention={onMentionAgent && logicalName && message.agentId && mentionableAgentIds?.has(message.agentId)
                ? () => onMentionAgent(logicalName)
                : undefined}
              resumable={message.resumable}
              onResume={onResumeAgent}
            />
          </footer>}
        </div>
      </article>
    );
  }

  // Artifacts created outside an agent run (assignment plans, most notably)
  // render as their card — a plan reads as its step summary, not a bare
  // "Artifact — Plan" line.
  if (message.artifact) {
    return (
      <div className={`msg msg-system msg-system-artifact tone-${message.tone}`}>
        <span className={`rail-node rail-node-system tone-${message.tone}`} aria-hidden="true" />
        <div className="msg-system-body">
          <ArtifactCard artifact={message.artifact} sessionId={sessionId} onOpenArtifact={onOpenArtifact} />
        </div>
        <MsgTime value={message.timestamp} />
      </div>
    );
  }

  return (
    <div className={`msg msg-system tone-${message.tone}`}>
      <span className={`rail-node rail-node-system tone-${message.tone}`} aria-hidden="true" />
      <div className="msg-system-body">
        <span className="msg-system-label">
          <span>{message.label}</span>
        </span>
        {message.detail ? (
          <span className="msg-system-detail" title={message.detail}>{message.detail}</span>
        ) : null}
      </div>
      <MsgTime value={message.timestamp} />
    </div>
  );
});
