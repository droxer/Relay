import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activeMentionQuery,
  applyMention,
  type MentionCandidate,
} from "../lib/mentions";

export type MentionAutocomplete = {
  /** Rows to render; empty means the popup is closed. */
  matches: MentionCandidate[];
  /** Track the caret so the open `@…` fragment can be found. */
  onCaretChange: (caret: number) => void;
  /** Hide the list while the draft is not focused, without retiring the
   *  fragment — see `blur`/`focus` below. */
  blur: () => void;
  focus: () => void;
  /**
   * Handle a key while the popup is open; false means the composer keeps it.
   *
   * Only the two keys the Combobox does NOT bind. The highlight (ArrowUp /
   * ArrowDown), its wraparound, and Enter-to-accept moved to the primitive
   * when the popup became a `Combobox` — leaving them here too would run both
   * paths on one keystroke and splice the accepted name in twice.
   */
  handleKey: (key: string) => boolean;
  pick: (candidate: MentionCandidate) => void;
};

/**
 * Owns the `@` autocomplete for a composer draft.
 *
 * The draft text stays in the composer; this hook only derives what the popup
 * shows and splices an accepted name back through `setText`. Keeping the text
 * in one place is what lets the plain textarea survive untouched.
 */
export function useMentionAutocomplete({ text, candidates, setText, textareaRef }: {
  text: string;
  candidates: readonly MentionCandidate[];
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}): MentionAutocomplete {
  const [caret, setCaret] = useState(0);
  // Escape retires ONE fragment, and is remembered as that fragment's text
  // rather than its offset. An offset is not an identity: `@` at the head of a
  // draft is offset 0 every time, so dismissing one there buried every later
  // mention typed in the same place — including one typed after the draft was
  // cleared — and the popup stayed dead for the rest of the session.
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null);
  const [acceptedText, setAcceptedText] = useState<string | null>(null);
  // Blur hides the list; it must NOT dismiss the fragment. Clicking the
  // transcript, the agent picker, or another window all blur the draft, and a
  // dismissal there left the author typing the rest of a name into a list that
  // would never come back.
  const [blurred, setBlurred] = useState(false);

  const open = useMemo(() => activeMentionQuery(text, caret), [text, caret]);
  // Typing further into a dismissed fragment keeps it dismissed — Escape means
  // "I know this name". Deleting back out of it, or opening a different one,
  // does not.
  const suppressed = Boolean(
    dismissed && open && dismissed.start === open.start && open.query.startsWith(dismissed.query),
  );
  const matches = useMemo(() => {
    if (!open || blurred || suppressed || acceptedText === text) return [];
    const needle = open.query.trim().toLowerCase();
    return candidates.filter(
      (candidate) => !needle || candidate.displayName.toLowerCase().includes(needle),
    );
  }, [acceptedText, blurred, candidates, open, suppressed, text]);

  // A dismissal outlives only its own fragment. Once the caret is no longer in
  // one, the next `@` starts clean wherever it is typed.
  useEffect(() => {
    if (!open && dismissed) setDismissed(null);
  }, [dismissed, open]);

  const blur = useCallback(() => setBlurred(true), []);
  const focus = useCallback(() => setBlurred(false), []);

  const close = useCallback(() => {
    setDismissed(open ? { start: open.start, query: open.query } : null);
  }, [open]);

  const pick = useCallback(
    (candidate: MentionCandidate) => {
      if (!open || !candidate.eligible) return;
      const applied = applyMention(text, open.start, caret, candidate.displayName);
      setText(applied.text);
      setDismissed(null);
      // A completed name still reads as an open `@…` fragment, so the popup
      // would otherwise stay up listing the agent just accepted. Closing it
      // against the exact accepted text — rather than the fragment's offset —
      // means editing that name straight back down to `@Le` re-opens it.
      setAcceptedText(applied.text);
      // The caret must land after the inserted name, which React would
      // otherwise push to the end of the value on the next render.
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(applied.caret, applied.caret);
        setCaret(applied.caret);
      });
    },
    [caret, open, setText, text, textareaRef],
  );

  const handleKey = useCallback(
    (key: string) => {
      if (matches.length === 0) return false;
      /* Tab accepts, because the Combobox binds Enter but not Tab, and a
         half-typed `@Ad` completing on Tab is the habit this composer was
         built around. It accepts the FIRST match rather than a tracked
         highlight: the highlight lives in the primitive now, and Tab without
         arrowing means "the obvious one". */
      if (key === "Tab") {
        const candidate = matches[0];
        if (!candidate?.eligible) return false;
        pick(candidate);
        return true;
      }
      /* Escape dismisses THIS fragment. The Combobox cannot do it: `open` is
         derived from `matches`, so the primitive closing itself would be
         overridden on the next render — the fragment has to be marked
         dismissed at the source. */
      if (key === "Escape") {
        close();
        return true;
      }
      return false;
    },
    [close, matches, pick],
  );

  return {
    matches,
    onCaretChange: setCaret,
    blur,
    focus,
    handleKey,
    pick,
  };
}
