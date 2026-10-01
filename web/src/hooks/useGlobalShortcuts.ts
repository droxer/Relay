"use client";

import { useEffect, useEffectEvent, useMemo } from "react";
import { createShortcutResolver, isCommandMenuChord, type ShortcutAction } from "@/lib/shortcuts";

/* App-wide keyboard layer. All suppression rules funnel through here:
   a modal dialog/drawer (anything aria-modal) owns the screen, and while one
   of our own overlays is open only its toggle chord still reaches us —
   the overlay handles the rest of its keys itself. */

export function useGlobalShortcuts({
  isAdmin,
  overlayOpen,
  onAction,
}: {
  isAdmin: boolean;
  /** True while the command menu or shortcuts help is open. */
  overlayOpen: boolean;
  onAction: (action: ShortcutAction) => void;
}) {
  const resolver = useMemo(() => createShortcutResolver({ isAdmin }), [isAdmin]);
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (overlayOpen) {
      // The overlay's own toggle chord still works from inside it
      // (its text field is an editable target, which the resolver would
      // otherwise rightly ignore).
      if (isCommandMenuChord(event)) {
        event.preventDefault();
        onAction({ kind: "command-menu" });
      }
      return;
    }
    // A dialog, drawer, or the preferences sheet owns the keyboard. Both
    // spellings are needed: base-ui sets `aria-modal` on a true modal, but
    // a focus-trapping non-modal popup (the thread space panel at its
    // takeover width) is marked only by the primitive's own slot.
    if (document.querySelector('[aria-modal="true"], [data-slot="dialog-content"]')) return;
    const action = resolver(event);
    if (!action) return;
    if (action.kind === "command-menu") event.preventDefault();
    onAction(action);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
