import {
  DisclosureChevron,
  ICON,
  StatusError,
  StatusInfo,
  StatusOk,
  StatusWarn,
} from "./icons";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexCollaborationEvent } from "relay-core";

import type { AgentName } from "../types";
import {
  AgentStreamAccumulator,
  commandDisplay,
  displayAgentStreamSegments,
  emptyAgentStreamSegments,
  hasTerminalOutcome,
  parseAgentStderr,
  reasoningOutline,
  reasoningSummary,
  segmentKeys,
  type AgentSegment,
} from "../lib/agentStream";
import { useHighlightedHtml } from "../hooks/useHighlightedHtml";
import { MarkdownContent } from "./LazyMarkdown";
import { buildCollaborationTree } from "../lib/collaborationTree";
import { SubagentTree } from "./SubagentTree";
import { useDebouncedStreamingAnnouncement, useSmoothStreamingText } from "../hooks/useSmoothStreamingText";

function StreamActivity({ label }: { label: string }) {
  return (
    <div className="agent-stream-activity" role="status">
      <span className="agent-stream-pulse" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

// Keys come from lib/agentStream so the identity rule — the CLI's own id where
// there is one, the per-kind ordinal otherwise — is testable and lives next to
// the segments it keys.
function keyedSegments(segments: AgentSegment[]): Array<{ key: string; segment: AgentSegment }> {
  const keys = segmentKeys(segments);
  return segments.map((segment, index) => ({ key: keys[index]!, segment }));
}

type AgentStreamProps = {
  agent: AgentName;
  stdout: string;
  stderr: string;
  streaming: boolean;
  collaborations: CodexCollaborationEvent[];
};

export function AgentStream({ agent, stdout, stderr, streaming, collaborations }: AgentStreamProps) {
  const { t } = useTranslation();
  // Settling can append a completed-log fallback that overlaps live output;
  // rebuild once at that boundary so the final transcript is canonical.
  const accumulator = useMemo(() => new AgentStreamAccumulator(agent), [agent, streaming]);
  // Completed turns stay checkpointed in the accumulator; only the unfinished
  // suffix is reparsed as new SSE output arrives.
  const displayed = useMemo(
    () => displayAgentStreamSegments(accumulator.update(stdout), parseAgentStderr(stderr), streaming),
    [accumulator, stdout, stderr, streaming],
  );
  const { segments, liveTextIndex } = displayed;
  const workingLabel = t("agent_stream.empty_working");
  // The run stays `streaming` until the daemon posts `agent.completed`, which
  // lands after the CLI's own end-of-turn frame — don't keep pulsing "Working…"
  // beneath a line that already says the agent finished.
  const showActivity = streaming && liveTextIndex < 0 && !hasTerminalOutcome(segments);
  const collaborationNodes = useMemo(
    () => buildCollaborationTree(collaborations, { settled: !streaming }),
    [collaborations, streaming],
  );

  if (segments.length === 0) {
    const emptySegments = emptyAgentStreamSegments(agent, streaming, t);
    if (emptySegments.length > 0) {
      return (
        <div className={`agent-stream ${streaming ? "streaming" : ""}`}>
          <SubagentTree nodes={collaborationNodes} />
          {keyedSegments(emptySegments).map(({ key, segment }) => (
            <SegmentView key={key} segment={segment} />
          ))}
          {showActivity ? <StreamActivity label={workingLabel} /> : null}
        </div>
      );
    }
    if (streaming) {
      return (
        <div className="agent-stream streaming">
          <SubagentTree nodes={collaborationNodes} />
          <StreamActivity label={workingLabel} />
        </div>
      );
    }
    if (collaborationNodes.length > 0) {
      return (
        <div className="agent-stream">
          <SubagentTree nodes={collaborationNodes} />
        </div>
      );
    }
    return <p className="msg-quiet">{t("agent_stream.empty_done")}</p>;
  }

  return (
    <div className={`agent-stream ${streaming ? "streaming" : ""}`}>
      <SubagentTree nodes={collaborationNodes} />
      {keyedSegments(segments).map(({ key, segment }, index) => (
        <SegmentView
          key={key}
          segment={segment}
          live={index === liveTextIndex}
          streaming={streaming}
          last={index === segments.length - 1}
        />
      ))}
      {showActivity ? <StreamActivity label={workingLabel} /> : null}
    </div>
  );
}

function SegmentView({
  segment,
  live = false,
  streaming = false,
  last = false,
}: { segment: AgentSegment; live?: boolean; streaming?: boolean; last?: boolean }) {
  const { t } = useTranslation();
  if (segment.kind === "text") {
    return <TextSegment text={segment.text} live={live} />;
  }
  if (segment.kind === "thinking") {
    // Only the trailing block of a running stream is still being written; every
    // earlier one has settled and collapses like any finished reasoning.
    return <ThinkingSegment text={segment.text} live={streaming && last} />;
  }
  if (segment.kind === "tool") {
    // A tool call is a single inline `⏺` mono line — the tool name plus the
    // file/command it acted on (design-system.md agent-turn: "⏺ for tool
    // lines"). No bordered chip; consecutive calls read as a compact log.
    return (
      <div className="agent-tool">
        <span className="agent-tool-marker" aria-hidden="true">⏺</span>
        <span className="agent-tool-name">{segment.name}</span>
        {segment.target ? <span className="agent-tool-target">{segment.target}</span> : null}
      </div>
    );
  }
  if (segment.kind === "command") {
    return <CommandSegment command={segment.command} />;
  }
  if (segment.kind === "narration") {
    return (
      <div className={`agent-status tone-${segment.params?.tone ?? "info"}`}>
        <StatusIcon tone={(segment.params?.tone as "good" | "bad" | "warn" | "info") ?? "info"} />
        <span>{t(segment.key, segment.params)}</span>
      </div>
    );
  }
  if (segment.kind === "status") {
    return (
      <div className={`agent-status tone-${segment.tone}`}>
        <StatusIcon tone={segment.tone} />
        <span>{segment.text}</span>
      </div>
    );
  }
  return <RawSegment text={segment.text} />;
}

// Reasoning renders as one disclosure per block: a header row naming the step,
// and — open — the steps themselves under a hairline rule (design-system.md
// agent-turn). This is the shape every current agent surface converged on, and
// it is the one the content asks for: a reasoning summary is a list of titled
// steps, not a paragraph.
//
// The body is verbatim model output rather than prose to reflow — its own line
// breaks carry the structure — so each line becomes a paragraph instead of
// collapsing into one run-on block. That also keeps the live caret, which the
// stylesheet hangs off the body's last `p`, tracking the end of the reasoning.
//
// A settled block is collapsed so a long deliberation cannot bury the answer.
// A live one opens itself: it is where the turn's only visible progress is
// happening. `open` is a null-until-touched override rather than a boolean, so
// a reader who opens a settled block keeps it open, one who closes a live block
// keeps it closed, and one who has touched neither still gets the automatic
// close when the run settles.
function ThinkingSegment({ text, live }: { text: string; live: boolean }) {
  const { t } = useTranslation();
  const [override, setOverride] = useState<boolean | null>(null);
  const sections = useMemo(() => reasoningOutline(text), [text]);
  const { label, steps } = useMemo(() => reasoningSummary(sections, { live }), [sections, live]);
  const open = override ?? live;

  if (sections.length === 0) return null;

  return (
    <div className={`agent-thinking ${open ? "is-open" : ""} ${live ? "is-live" : ""}`}>
      <button
        type="button"
        className="agent-thinking-header"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <DisclosureChevron size={ICON.xs} className="agent-thinking-chevron" aria-hidden="true" />
        {/* The visible label is the step name, which does not say which tier it
            belongs to; the marker that carries that is a glyph a screen reader
            never reads out. */}
        <span className="sr-only">{t("agent_stream.reasoning_label")}</span>
        <span className="agent-thinking-headline">{label}</span>
        {steps > 1 ? (
          <span className="agent-thinking-steps">{t("agent_stream.reasoning_steps", { count: steps })}</span>
        ) : null}
      </button>
      {open ? (
        <div className="agent-thinking-body">
          {sections.map((section, sectionIndex) => (
            <div className="agent-thinking-step" key={`step-${sectionIndex}`}>
              {section.title ? <p className="agent-thinking-title">{section.title}</p> : null}
              {section.lines.map((line, lineIndex) => (
                <p key={`line-${lineIndex}`}>{line}</p>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// CLI output the parser could not classify. It is still the agent talking —
// usually its Markdown answer arriving in a shape this parser does not know —
// so it renders as Markdown rather than as a monospace dump with its own ```
// fences left showing. The block keeps its frame so it still reads as
// unrecognised output rather than as ordinary prose.
function RawSegment({ text }: { text: string }) {
  return (
    <div className="agent-raw">
      <div className="md-body agent-prose">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
}

// A shell command the agent ran: the `⏺` mono line of the tool log, but
// highlighted as bash so the invocation reads as code rather than as a wall of
// monospace. A command that carries a file body (`cat > f << \'EOF\'`) collapses
// to its first lines — otherwise one write buries the answer it was working
// towards — and opens on a click.
function CommandSegment({ command }: { command: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { lines, hidden, toggle } = useMemo(
    () => commandDisplay(command, { expanded }),
    [command, expanded],
  );
  const html = useHighlightedHtml(useMemo(() => lines.join("\n"), [lines]), "bash");

  return (
    <div className="agent-command code">
      <span className="agent-tool-marker" aria-hidden="true">⏺</span>
      <div className="agent-command-body">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        {toggle ? (
          <button
            type="button"
            className="agent-command-toggle"
            aria-expanded={toggle === "collapse"}
            onClick={() => setExpanded((open) => !open)}
          >
            {toggle === "collapse"
              ? t("agent_stream.command_collapse")
              : t("agent_stream.command_expand", { count: hidden })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TextSegment({ text, live }: { text: string; live: boolean }) {
  const visibleText = useSmoothStreamingText(text, live);
  const announcement = useDebouncedStreamingAnnouncement(text, live);
  return (
    <div className={`agent-text ${live ? "is-live" : ""}`}>
      {/* `md-body` is not optional decoration: every markdown element rule
          (headings, paragraphs, lists, blockquotes, inline code) in
          styles/markdown.css is scoped to it. Without it the transcript
          renders unstyled — headings collapse to body-sized plain text. */}
      <div className="md-body agent-prose" aria-hidden={live || undefined}>
        <MarkdownContent text={visibleText} live={live} />
      </div>
      {live ? (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      ) : null}
    </div>
  );
}

function StatusIcon({ tone }: { tone: "good" | "bad" | "warn" | "info" }) {
  if (tone === "good") return <StatusOk size={ICON.sm} aria-hidden="true" />;
  if (tone === "bad") return <StatusError size={ICON.sm} aria-hidden="true" />;
  if (tone === "warn") return <StatusWarn size={ICON.sm} aria-hidden="true" />;
  return <StatusInfo size={ICON.sm} aria-hidden="true" />;
}
