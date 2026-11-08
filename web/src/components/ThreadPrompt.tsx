"use client";

import { useId, useState, type ReactNode } from "react";
import { useKeyChange } from "../hooks/useKeyChange";
import { ChevronDownIcon, ICON } from "./icons";

/**
 * A process notice in a thread (proposed changes, a setup cue, suggested next
 * steps) that the person may skip. The notice's own heading is the disclosure:
 * a quiet chevron beside the title folds the body away, so skipping costs no
 * extra row or button. A folded notice still names itself, plus `summary`
 * (e.g. "Changes applied") when given.
 *
 * Folding only changes presentation: the body stays mounted, so a draft typed
 * into it survives. `defaultCollapsed` is the resting state (a settled notice
 * rests folded); when it changes, the person's own toggle is forgotten so a
 * notice that just settled folds itself. Prompts that need an answer
 * (questions, permissions, decisions, review) never use this.
 */
export function ThreadPrompt({ title, summary, defaultCollapsed = false, level = 3, className, headingClassName, children }: {
  title: string;
  summary?: string;
  defaultCollapsed?: boolean;
  level?: 2 | 3;
  className?: string;
  headingClassName?: string;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  useKeyChange(defaultCollapsed, () => setOverride(null));
  const collapsed = override ?? defaultCollapsed;
  const contentId = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className={["thread-prompt", className].filter(Boolean).join(" ")} aria-label={title} data-collapsed={collapsed || undefined}>
      <Heading className={["thread-prompt-heading", headingClassName].filter(Boolean).join(" ")}>
        <button type="button" className="thread-prompt-toggle" aria-expanded={!collapsed} aria-controls={contentId}
          onClick={() => setOverride(!collapsed)}>
          <span className="thread-prompt-title">{title}</span>
          {summary ? <span className="thread-prompt-summary">{summary}</span> : null}
          <ChevronDownIcon className="thread-prompt-chevron" size={ICON.sm} aria-hidden="true" />
        </button>
      </Heading>
      <div id={contentId} className="thread-prompt-body" hidden={collapsed}>{children}</div>
    </section>
  );
}
