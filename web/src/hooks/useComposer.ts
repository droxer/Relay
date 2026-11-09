import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { resizeComposerTextarea } from "../lib/composerResize";

const DRAFT_RESTORED_EVENT = "relay:composer-draft-restored";

// Composer text and textarea sizing stay local so every keystroke does not
// re-render the full application shell and transcript.
export function useComposer(draftKey?: string): {
  composerText: string;
  setComposerText: Dispatch<SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  resizeTextarea: () => void;
} {
  const [draft, setDraft] = useState(() => ({ key: draftKey, text: readDraft(draftKey) }));
  // Adopt before paint so another thread's draft never flashes in the editor.
  if (draft.key !== draftKey) setDraft({ key: draftKey, text: readDraft(draftKey) });
  const composerText = draft.key === draftKey ? draft.text : readDraft(draftKey);
  const setComposerText = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setDraft((current) => {
      const previous = current.key === draftKey ? current.text : readDraft(draftKey);
      const text = typeof next === "function" ? next(previous) : next;
      writeDraft(draftKey, text);
      return { key: draftKey, text };
    });
  }, [draftKey]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // A rejected send may return after its author left and reopened this
  // thread. Update only the composer whose persisted draft was restored.
  useLayoutEffect(() => {
    const restored = (event: Event) => {
      const { key, text } = (event as CustomEvent<{ key: string; text: string }>).detail;
      if (key === draftKey) setDraft({ key, text });
    };
    window.addEventListener(DRAFT_RESTORED_EVENT, restored);
    return () => window.removeEventListener(DRAFT_RESTORED_EVENT, restored);
  }, [draftKey]);

  const resizeTextarea = useCallback(() => {
    resizeComposerTextarea(textareaRef.current);
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [composerText, resizeTextarea]);

  return {
    composerText, setComposerText,
    textareaRef,
    resizeTextarea,
  };
}

/** The key a Thread's composer keeps its draft under, per signed-in user. */
export function threadDraftKey(user: { userId?: string; username: string }, sessionId: string | null | undefined): string {
  return JSON.stringify([user.userId ?? user.username, sessionId ?? "new"]);
}

/** Puts suggested text in a Thread's composer before it opens. Text the
 *  person already left there wins: a suggestion never overwrites a draft. */
export function seedComposerDraft(key: string, text: string): void {
  if (!readDraft(key).trim()) writeDraft(key, text);
}

/** Restore rejected text to its original thread without losing a newer draft. */
export function restoreComposerDraft(key: string, text: string): void {
  if (!text.trim()) return;
  const current = readDraft(key);
  const restored = current.trim() && current !== text ? `${text}\n\n${current}` : text;
  writeDraft(key, restored);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DRAFT_RESTORED_EVENT, { detail: { key, text: restored } }));
  }
}

function readDraft(key?: string): string {
  if (!key || typeof window === "undefined") return "";
  try { return sessionStorage.getItem(`relay-web.draft:${key}`) ?? ""; }
  catch { return ""; }
}

function writeDraft(key: string | undefined, text: string): void {
  if (!key || typeof window === "undefined") return;
  try {
    const storageKey = `relay-web.draft:${key}`;
    if (text) sessionStorage.setItem(storageKey, text);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Storage may be disabled or full; the live editor remains usable.
  }
}
