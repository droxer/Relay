import type { ReactNode } from "react";

/**
 * One settled fact on the targets rail: "Runs on <machine>", "Runs in
 * <project>".
 *
 * Every surface answers "where does this round run" — a staging thread with a
 * picker, a started thread with its pinned computer, a project thread with its
 * room — and the two read-only answers used to be drawn twice, in opposite
 * languages: the computer as a chrome-less line, the project as a bordered
 * pill that looked clickable but was not. They share this shape now, so a
 * thread that moves between surfaces changes its words, never its material.
 *
 * The interactive answer keeps its Select trigger: chrome is what separates
 * the one slot you can act on from the ones you cannot.
 */
export function ComposerContextLine({ label, mark, name, online = true, title, srDetail }: {
  /** The quiet lead-in word — what kind of fact this is. */
  label: string;
  /** Presence dot, workspace glyph — whatever identifies the value's kind. */
  mark?: ReactNode;
  name: string;
  /** Drops the line another ink step: the fact still reads, it stops reading live. */
  online?: boolean;
  title?: string;
  /** Detail carried visually by the mark or the tooltip, spelled out for AT. */
  srDetail?: string;
}) {
  return (
    <span
      className="composer-context"
      data-online={online ? "true" : "false"}
      title={title}
    >
      <span className="composer-context-label">{label}</span>
      {mark}
      <span className="composer-context-name" translate="no">{name}</span>
      {srDetail ? <span className="sr-only">{srDetail}</span> : null}
    </span>
  );
}
