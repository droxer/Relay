import type { RelaySession } from "../types.js";
import { sessionTrailsSummary } from "./sessionPollMerge.ts";

export type ThreadPanelLayout = {
  /** A new thread with nothing sent yet: the composer is the page (chat.css). */
  landing: boolean;
  /** The transcript has nothing true to draw yet and stays empty. */
  transcriptPending: boolean;
};

/**
 * How the chat panel is laid out before and while its thread arrives.
 *
 * Both answers wait for what is known rather than guess at it. While the
 * thread list loads, no thread is known to be missing, so the panel keeps its
 * docked shape instead of drawing the centred new-thread landing — a deep link
 * used to draw the landing, then drop the composer to the dock once its
 * thread arrived. And a thread that is only its list summary has no turns yet:
 * drawing its goal bubble and "starting" cue, then having the detail's turns
 * land above and push them away, was the transcript's layout shift.
 */
export function threadPanelLayout(input: {
  threadsLoading: boolean;
  activeSession: RelaySession | undefined;
  hasPendingMessage: boolean;
  hasOnboardingPanel: boolean;
}): ThreadPanelLayout {
  const { threadsLoading, activeSession, hasPendingMessage, hasOnboardingPanel } = input;
  const summaryOnly = activeSession !== undefined
    && activeSession.events.length === 0
    && sessionTrailsSummary(activeSession);
  return {
    landing: !threadsLoading && !activeSession && !hasPendingMessage && !hasOnboardingPanel,
    transcriptPending: !hasPendingMessage && (threadsLoading || summaryOnly),
  };
}
