import {
  DisclosureChevron,
  ICON,
  StatusError,
  StatusInfo,
  StatusOk,
  StatusWarn,
} from "./icons";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexCollaborationEvent } from "relay-core";

import type { AgentName } from "../types";
import {
  AgentStreamAccumulator,
  commandDisplay,
  displayAgentStreamSegments,
  hasTerminalOutcome,
  parseAgentStderr,
  reasoningOutline,
  reasoningSummary,
  segmentKeys,
  type AgentSegment,
} from "../lib/agentStream";
import { useHighlightedHtml } from "../hooks/useHighlightedHtml";
import { MarkdownContent } from "./LazyMarkdown";
import { createMarkdownBlockSplitter } from "../lib/markdownBlocks";
import { buildCollaborationTree } from "../lib/collaborationTree";
import { SubagentTree } from "./SubagentTree";
import { useDebouncedStreamingAnnouncement, useSmoothStreamingText } from "../hooks/useSmoothStreamingText";
import { useKeyChange } from "../hooks/useKeyChange";
import { activityCounts, groupActivity, type ActivityEntry, type ActivityItem } from "../lib/activityGroups";
import { placePermissionAudits } from "../lib/permissionAudits";
import type { PermissionAudit } from "../lib/projectMessages";

// "Working…" breathes on the shared live blink: plain words that dim and
// return, not a gradient sweep across them.
function StreamActivity({ label }: { label: string }) {
  return (
    <div className="agent-stream-activity" role="status">
      <span className="agent-stream-live-label">{label}</span>
    </div>
  );
}

/** Last frame's grouped items per live stream; see `items` in AgentStream. */
const previousItemsByStream = new WeakMap<AgentStreamAccumulator, ActivityItem[]>();

type AgentStreamProps = {
  agent: AgentName;
  stdout: string;
  stderr: string;
  streaming: boolean;
  collaborations: CodexCollaborationEvent[];
  /** How this run's permission prompts closed; each shows on its tool line. */
  permissions?: PermissionAudit[];
  pickupFrom?: string;
};

const NO_AUDITS: ReadonlyMap<string, PermissionAudit> = new Map();

export function AgentStream({ agent, stdout, stderr, streaming, collaborations, permissions, pickupFrom }: AgentStreamProps) {
  const { t } = useTranslation();
  // Settling can append a completed-log fallback that overlaps live output;
  // rebuild once at that boundary so the final transcript is canonical.
  const [accumulator, setAccumulator] = useState(() => new AgentStreamAccumulator(agent));
  useKeyChange(`${agent}\u0000${streaming}`, () => setAccumulator(new AgentStreamAccumulator(agent)));
  // Completed turns stay checkpointed in the accumulator; only the unfinished
  // suffix is reparsed as new SSE output arrives.
  const displayed = useMemo(
    () => displayAgentStreamSegments(accumulator.update(stdout), parseAgentStderr(stderr), streaming),
    [accumulator, stdout, stderr, streaming],
  );
  const { segments, liveTextIndex } = displayed;
  // A handoff turn that has not produced anything yet is still being picked
  // up (queued, booting, reading the prior work) — say whose work it takes.
  const workingLabel = pickupFrom && segments.length === 0
    ? t("agent_stream.picking_up", { agent: pickupFrom })
    : t("agent_stream.empty_working");
  // The run stays `streaming` until the daemon posts `agent.completed`, which
  // lands after the CLI's own end-of-turn frame — don't keep pulsing "Working…"
  // beneath a line that already says the agent finished.
  const showActivity = streaming && liveTextIndex < 0 && !hasTerminalOutcome(segments);
  const collaborationNodes = useMemo(
    () => buildCollaborationTree(collaborations, { settled: !streaming }),
    [collaborations, streaming],
  );
  // Grouped against last frame's items so a group whose calls have not
  // changed keeps its object, and the memoized ActivityGroup above it skips.
  // The previous items are remembered per stream (the accumulator is
  // replaced exactly when the stream restarts); they only choose which equal
  // object to hand back, so this is a cache, not state.
  const keys = useMemo(() => segmentKeys(segments), [segments]);
  const items = useMemo(() => {
    const next = groupActivity(segments, keys, previousItemsByStream.get(accumulator) ?? []);
    previousItemsByStream.set(accumulator, next);
    return next;
  }, [accumulator, segments, keys]);
  // An approval reads on the line it let run, not in a second list below.
  const audits = useMemo(() => placePermissionAudits(segments, keys, permissions), [segments, keys, permissions]);
  const unplaced = audits.unplaced.map((audit) => <PermissionLine key={audit.id} audit={audit} />);

  if (segments.length === 0) {
    if (streaming) {
      return (
        <div className="agent-stream streaming">
          <SubagentTree nodes={collaborationNodes} />
          {unplaced}
          <StreamActivity label={workingLabel} />
        </div>
      );
    }
    if (collaborationNodes.length > 0 || unplaced.length > 0) {
      return (
        <div className="agent-stream">
          <SubagentTree nodes={collaborationNodes} />
          {unplaced}
        </div>
      );
    }
    return <p className="msg-quiet">{t("agent_stream.empty_done")}</p>;
  }

  return (
    <div className={`agent-stream ${streaming ? "streaming" : ""}`}>
      <SubagentTree nodes={collaborationNodes} />
      {/* Keys come from lib/agentStream so the identity rule — the CLI's own
          id where there is one, the per-kind ordinal otherwise — is testable
          and lives next to the segments it keys. */}
      {items.map((item) => item.type === "activity" ? (
        <ActivityGroup
          key={item.key}
          entries={item.entries}
          audits={audits.bySegment.size > 0 ? audits.bySegment : NO_AUDITS}
          live={streaming && item.entries.at(-1)!.index === segments.length - 1}
        />
      ) : (
        <SegmentView
          key={item.key}
          segment={item.segment}
          audit={audits.bySegment.get(item.key)}
          live={item.index === liveTextIndex}
          streaming={streaming}
          last={item.index === segments.length - 1}
        />
      ))}
      {unplaced}
      {showActivity ? <StreamActivity label={workingLabel} /> : null}
    </div>
  );
}

// Every segment component is memoized: a streamed frame changes one segment
// — the live text or the open reasoning — and the rest must not re-render.
const SegmentView = memo(function SegmentView({
  segment,
  audit,
  live = false,
  streaming = false,
  last = false,
}: { segment: AgentSegment; audit?: PermissionAudit; live?: boolean; streaming?: boolean; last?: boolean }) {
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
    // A tool call is a single inline line — the tool name plus the file or
    // command it acted on. No bordered chip; consecutive calls fold into an
    // ActivityGroup. The marker is a CSS dot: the `⏺` glyph the terminal
    // renderer prints falls back to the colour-emoji font in a browser and
    // drew a blue tile on every line.
    return (
      <div className="agent-tool">
        <span className="agent-tool-marker" aria-hidden="true" />
        <span className="agent-tool-name">{segment.name}</span>
        {segment.target ? <span className="agent-tool-target">{segment.target}</span> : null}
        {audit ? <PermissionMark audit={audit} /> : null}
      </div>
    );
  }
  if (segment.kind === "command") {
    return <CommandSegment command={segment.command} audit={audit} />;
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
  return <RawSegment text={segment.text} streaming={streaming && last} />;
});

// A run of tool calls and commands, folded behind a one-line summary ("Used 2
// tools, ran 3 commands") so the log stops burying the answer it was working
// towards. Same null-until-touched override as ThinkingSegment: a live group
// is open — it is where the turn's visible progress is — and closes itself
// when the next text arrives, unless the reader already chose.
const ActivityGroup = memo(function ActivityGroup({
  entries,
  audits,
  live,
}: { entries: ActivityEntry[]; audits: ReadonlyMap<string, PermissionAudit>; live: boolean }) {
  const { t } = useTranslation();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? live;
  const { tools, commands } = activityCounts(entries.map((entry) => entry.segment));
  const summary = tools === 0
    ? t("agent_stream.activity_commands_only", { count: commands })
    : [
        t("agent_stream.activity_tools", { count: tools }),
        commands > 0 ? t("agent_stream.activity_commands", { count: commands }) : null,
      ].filter(Boolean).join(t("agent_stream.activity_separator"));

  return (
    <div className={`agent-activity ${open ? "is-open" : ""} ${live ? "is-live" : ""}`}>
      <button
        type="button"
        className="agent-activity-header"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <DisclosureChevron size={ICON.xs} className="agent-activity-chevron" aria-hidden="true" />
        <span className="agent-activity-summary">{summary}</span>
      </button>
      {open ? (
        <div className="agent-activity-body">
          {entries.map(({ key, segment }) => (
            <SegmentView key={key} segment={segment} audit={audits.get(key)} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

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
const ThinkingSegment = memo(function ThinkingSegment({ text, live }: { text: string; live: boolean }) {
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
});

// CLI output the parser could not classify. It is still the agent talking —
// usually its Markdown answer arriving in a shape this parser does not know —
// so it renders as Markdown rather than as a monospace dump with its own ```
// fences left showing. The block keeps its frame so it still reads as
// unrecognised output rather than as ordinary prose.
function RawSegment({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="agent-raw">
      <div className="md-body agent-prose">
        {/* Raw output never rendered in live mode; it only borrows the
            per-block parse while it is still growing. */}
        {streaming ? <StreamingMarkdown text={text} live={false} /> : <MarkdownContent text={text} />}
      </div>
    </div>
  );
}

// One top-level block of streamed Markdown. Memoized on its text, so a
// frame that only grows the tail block leaves every earlier block's parse alone.
const MarkdownBlock = memo(function MarkdownBlock({ text, live }: { text: string; live: boolean }) {
  return <MarkdownContent text={text} live={live} />;
});

// Streamed Markdown renders block by block: re-parsing the whole reply on every
// animation frame made a long answer's total parse work quadratic in its
// length. The blocks are siblings with no wrapper, so the DOM — and the caret
// rules in agent-stream.css that hang off `.agent-prose > :last-child` — match
// a single parse. Only the last block is in flight: every boundary
// splitMarkdownBlocks finds sits outside any fence, so an earlier block's fences
// are closed and render settled, while a half-written fence is always in the
// last block and stays `live`.
//
// Trade-off: rehype-slug dedupes heading ids per parse, so two equal headings
// in different blocks share an id while the reply streams. Settled text goes
// back to a single parse (see TextSegment / RawSegment), so the final document
// gets the same `-1` suffixes as before; only mid-stream `#` links can land on
// the first of two equal headings.
function StreamingMarkdown({ text, live }: { text: string; live: boolean }) {
  // One splitter per stream: a frame that appends to the text resumes the
  // scan at the line that was still open, instead of reading the whole
  // reply again. Any other text (a reset, a rewrite) starts the scan over.
  const [splitter] = useState(createMarkdownBlockSplitter);
  const blocks = useMemo(() => splitter.split(text), [splitter, text]);
  // Index keys are the right identity: a streamed prefix only grows, so block
  // N stays block N and keeps its memoized parse.
  return blocks.map((block, index) => (
    <MarkdownBlock key={index} text={block} live={live && index === blocks.length - 1} />
  ));
}

// A shell command the agent ran: the `⏺` mono line of the tool log, but
// highlighted as bash so the invocation reads as code rather than as a wall of
// monospace. A command that carries a file body (`cat > f << \'EOF\'`) collapses
// to its first lines — otherwise one write buries the answer it was working
// towards — and opens on a click.
function CommandSegment({ command, audit }: { command: string; audit?: PermissionAudit }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { lines, hidden, toggle } = useMemo(
    () => commandDisplay(command, { expanded }),
    [command, expanded],
  );
  const html = useHighlightedHtml(useMemo(() => lines.join("\n"), [lines]), "bash");

  return (
    <div className="agent-command code">
      <span className="agent-tool-marker" aria-hidden="true" />
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
      {audit ? <PermissionMark audit={audit} /> : null}
    </div>
  );
}

// How a permission prompt for this line closed — "Allowed", "Denied" — as a
// quiet suffix on the line itself; the full sentence and any note ride the
// title. Only a deny is coloured: it is the one that changed what ran.
function PermissionMark({ audit }: { audit: PermissionAudit }) {
  const { t } = useTranslation();
  const title = [audit.label, audit.detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`agent-permission-mark tone-${audit.tone}`} title={title}>
      {t(`agent_stream.permission.${audit.outcome}`)}
    </span>
  );
}

// A prompt no line of the turn matches (a question, or a call the stream never
// showed) still reads inside the turn that asked, as its own line.
function PermissionLine({ audit }: { audit: PermissionAudit }) {
  return (
    <div className={`agent-permission-line tone-${audit.tone}`}>
      <span className="agent-tool-marker" aria-hidden="true" />
      <span className="agent-tool-name">{audit.label}</span>
      {audit.detail ? <span className="agent-tool-target">{audit.detail}</span> : null}
    </div>
  );
}

// Split by liveness rather than branching inside one component: the smoothing
// and announcement hooks are only for the text still being written, and a
// settled segment — every earlier one in a long turn — must not pay for them
// or re-render when they tick.
function TextSegment({ text, live }: { text: string; live: boolean }) {
  return live ? <LiveTextSegment text={text} /> : <SettledTextSegment text={text} />;
}

const SettledTextSegment = memo(function SettledTextSegment({ text }: { text: string }) {
  return (
    <div className="agent-text">
      {/* `md-body` is not optional decoration: every markdown element rule
          (headings, paragraphs, lists, blockquotes, inline code) in
          styles/markdown.css is scoped to it. Without it the transcript
          renders unstyled — headings collapse to body-sized plain text. */}
      <div className="md-body agent-prose">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
});

function LiveTextSegment({ text }: { text: string }) {
  const visibleText = useSmoothStreamingText(text, true);
  const announcement = useDebouncedStreamingAnnouncement(text, true);
  return (
    <div className="agent-text is-live">
      <div className="md-body agent-prose" aria-hidden>
        <StreamingMarkdown text={visibleText} live />
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}

function StatusIcon({ tone }: { tone: "good" | "bad" | "warn" | "info" }) {
  if (tone === "good") return <StatusOk size={ICON.sm} aria-hidden="true" />;
  if (tone === "bad") return <StatusError size={ICON.sm} aria-hidden="true" />;
  if (tone === "warn") return <StatusWarn size={ICON.sm} aria-hidden="true" />;
  return <StatusInfo size={ICON.sm} aria-hidden="true" />;
}
