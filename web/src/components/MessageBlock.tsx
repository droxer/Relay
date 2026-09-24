import {
  ICON,
  IdentityUser,
  MetricTokens,
  StreamAttachment,
} from "./icons";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AgentMark } from "./AgentMark";
import { AgentStream } from "./AgentStream";
import { MarkdownContent } from "./LazyMarkdown";
import { MessageTurnActions } from "./MessageTurnActions";
import type { AgentName } from "../types";
import { AGENT_NAMES } from "../types";
import { imageForAgentRun, labelForAgentRun, labelForExecutor } from "../lib/agentDisplayNames";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { formatCompactTokens } from "../lib/tokenUsage";
import { parsePlanSteps, type PlanStep } from "../lib/plan";
import type { RelayArtifact } from "relay-core";
import { useArtifactBody } from "../lib/useArtifactBody";
import { summarizeArtifact } from "../lib/artifactStats";
import { useArtifactViewer } from "./ArtifactViewerProvider";
import type { DerivedMessage } from "../lib/projectMessages";
import { Button } from "@/components/ui/button";
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
        <span className="sr-only" role="status">{t("artifact.plan_loading", { defaultValue: "Loading…" })}</span>
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

function ArtifactCard({ artifact, sessionId, allArtifacts, onOpenArtifact, agentDisplayNames }: { artifact: RelayArtifact; sessionId: string; allArtifacts?: RelayArtifact[]; onOpenArtifact?: (artifact: RelayArtifact) => void; agentDisplayNames?: Partial<Record<AgentName, string>> }) {
  if (artifact.kind === "plan") {
    return <PlanCard artifact={artifact} sessionId={sessionId} agentDisplayNames={agentDisplayNames} />;
  }
  return <ArtifactChip artifact={artifact} sessionId={sessionId} allArtifacts={allArtifacts} onOpenArtifact={onOpenArtifact} />;
}

// Chips only fetch bodies small enough that the stat is worth the transfer;
// beyond this the chip shows byte size and the drawer fetches on demand.
const ARTIFACT_STAT_FETCH_MAX_BYTES = 256 * 1024;

function ArtifactChip({ artifact, sessionId, allArtifacts, onOpenArtifact }: { artifact: RelayArtifact; sessionId: string; allArtifacts?: RelayArtifact[]; onOpenArtifact?: (artifact: RelayArtifact) => void }) {
  const { t, i18n } = useTranslation();
  const viewer = useArtifactViewer();
  const locale = i18n.language || undefined;
  const shouldLoadBody =
    artifact.kind !== "workspace_file" &&
    (artifact.bytes === undefined || artifact.bytes <= ARTIFACT_STAT_FETCH_MAX_BYTES);

  // The body is loaded once (shared with the viewer drawer) so the chip can
  // show a semantic stat — +/−, pass/fail — instead of raw byte size.
  const body = useArtifactBody(sessionId, artifact.id, { enabled: shouldLoadBody });
  const stat = shouldLoadBody && body.isSuccess ? summarizeArtifact(artifact.kind, body.data ?? "") : null;
  const kindLabel = t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind });
  return (
    <article className="artifact-chip" data-kind={artifact.kind}>
      <Button variant="ghost"
        type="button"
        className="artifact-chip-main"
        onClick={() => {
          if (onOpenArtifact) onOpenArtifact(artifact);
          else viewer.open(artifact, sessionId, allArtifacts);
        }}
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
  styleFallback?: boolean;
  message: DerivedMessage;
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
  onRetryAgent?: (agent: AgentName, agentId?: string) => void;
  retryDisabled?: boolean;
};

export const MessageBlock = memo(function MessageBlock({
  slotLabel,
  styleFallback,
  message,
  sessionId,
  grouped = false,
  agentDisplayNames,
  logicalAgentNames,
  logicalAgentImages,
  onOpenArtifact,
  onRetryAgent,
  retryDisabled = false,
}: MessageBlockProps) {
  const { t, i18n } = useTranslation();
  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language || undefined), [i18n.language]);
  if (message.kind === "user") {
    return (
      <article className="msg msg-user" aria-label={t("message.user_label")}>
        <span className="rail-node rail-node-user" aria-hidden="true">
          <IdentityUser size={ICON.sm} />
        </span>
        <div className="turn-body">
          {/* The user's own Markdown renders like the agent's: a pasted fence
              is a highlighted block, not a paragraph with backticks in it.
              Same escaped pipeline as the agent side — no raw HTML. */}
          <div className="user-text md-body agent-prose">
            <MarkdownContent text={message.text} />
          </div>
        </div>
        <MsgTime value={message.timestamp} />
      </article>
    );
  }

  if (message.kind === "agent") {
    const agentName = labelForAgentRun(message, logicalAgentNames, agentDisplayNames);
    return (
      <article
        className={`msg msg-agent ${message.streaming ? "streaming" : ""} ${grouped ? "grouped" : ""}`}
        aria-label={t("message.agent_header", { employee: agentName })}
      >
        <span className="rail-node rail-node-agent" aria-hidden="true">
          <ProfileImage
            src={imageForAgentRun(message, logicalAgentImages)}
            alt=""
            fallback={<IdentityMark kind="agent" />}
          />
        </span>
        <div className="turn-body">
          {/* Who is speaking, beside its mark. A continuation from the same
              agent hides this (see .msg-agent.grouped in chat.css), so a run
              of turns reads as one speaker rather than a repeated name. */}
          <header className="msg-speaker" translate="no">{agentName}{slotLabel ? <span className="msg-speaker-slot">{t(slotLabel)}</span> : null}</header>
          {styleFallback ? <p className="collab-status">{t("collab_style.ran_solo")}</p> : null}
          <AgentStream
            agent={message.agent}
            stdout={message.stdout}
            stderr={message.stderr}
            streaming={message.streaming}
            collaborations={message.collaborations}
          />
          {message.attachments.length > 0 ? (
            <div className="attachment-list">
              {message.attachments.map((artifact) => (
                <ArtifactCard key={artifact.id} artifact={artifact} sessionId={sessionId} allArtifacts={message.attachments} onOpenArtifact={onOpenArtifact} agentDisplayNames={agentDisplayNames} />
              ))}
            </div>
          ) : null}
          <footer className="msg-turn-foot">
            {message.tokenUsage ? (
              <span
                className="msg-tokens"
                title={t("thread.token_usage_title", {
                  input: numberFormat.format(message.tokenUsage.input),
                  output: numberFormat.format(message.tokenUsage.output),
                  cache: numberFormat.format(message.tokenUsage.cache),
                })}
                aria-label={t("thread.token_usage_title", {
                  input: numberFormat.format(message.tokenUsage.input),
                  output: numberFormat.format(message.tokenUsage.output),
                  cache: numberFormat.format(message.tokenUsage.cache),
                })}
              >
                <MetricTokens size={ICON.sm} aria-hidden="true" />
                <span className="msg-turn-action-label">
                  {formatCompactTokens(message.tokenUsage.total, i18n.language)} {t("thread.tokens_short")}
                </span>
              </span>
            ) : null}
            <MessageTurnActions
              agent={message.agent}
              agentId={message.agentId}
              stdout={message.stdout}
              stderr={message.stderr}
              streaming={message.streaming}
              retryDisabled={retryDisabled}
              onRetry={onRetryAgent}
            />
          </footer>
        </div>
        <MsgTime value={message.timestamp} />
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
          <span className="msg-system-detail">{message.detail}</span>
        ) : null}
      </div>
      <MsgTime value={message.timestamp} />
    </div>
  );
});
