"use client";

import { useMemo } from "react";
import type { TFunction } from "i18next";
import type { DaemonNodeMonitorRecord, RelaySession } from "../types";
import type { DerivedMessage } from "../components/MessageBlock";
import { findActiveRunOwnerForSession, isThreadRunInFlight } from "../lib/threadRunning";
import { useThreadSendStore } from "../lib/threadSendStore";
import { useProjectedMessages } from "./useProjectedMessages";
import { useTranscriptPin } from "./useTranscriptPin";

type TranscriptPin = ReturnType<typeof useTranscriptPin>;

/**
 * The open thread's transcript as the reader sees it: the projected messages
 * plus the optimistic echo of a just-sent turn, whether a run is in flight,
 * and the scroll pin that keeps the newest block in view.
 */
export function useThreadTranscript(
  activeSession: RelaySession | undefined,
  visibleNodes: DaemonNodeMonitorRecord[],
  t: TFunction,
): {
  activeRunOwner: ReturnType<typeof findActiveRunOwnerForSession>;
  activeRun: NonNullable<ReturnType<typeof findActiveRunOwnerForSession>>["run"] | undefined;
  pendingUserMessage: { id: string; text: string } | null;
  threadRunning: boolean;
  displayMessages: DerivedMessage[];
  transcript: TranscriptPin;
} {
  // Optimistic echo of the just-sent turn: shown immediately so the user sees
  // their message without waiting for the provision + run round-trip. It is
  // hidden once the persisted turn arrives (matched by id for a continued
  // session, or by text for the goal of a freshly created one).
  const pendingEcho = useThreadSendStore((s) => s.pendingUserMessage);
  const isRunning = useThreadSendStore((s) => s.dispatching);
  const activeRunOwner = useMemo(
    () => findActiveRunOwnerForSession(visibleNodes, activeSession?.id),
    [visibleNodes, activeSession?.id],
  );
  const activeRun = activeRunOwner?.run;
  const messages = useProjectedMessages(activeSession, t);
  const pendingUserMessage = pendingEcho && !messages.some(
    (message) => message.kind === "user" && (message.id === pendingEcho.id || message.text === pendingEcho.text),
  ) ? pendingEcho : null;
  const threadRunning = isThreadRunInFlight({
    activeRun,
    session: activeSession,
    pendingSend: pendingUserMessage !== null,
    dispatchingRun: isRunning,
  });
  const displayMessages = useMemo<DerivedMessage[]>(() => {
    if (!pendingUserMessage) return messages;
    return [
      ...messages,
      { kind: "user", id: pendingUserMessage.id, timestamp: new Date().toISOString(), text: pendingUserMessage.text },
    ];
  }, [messages, pendingUserMessage]);

  // Declared after displayMessages: the pin re-runs on block count and
  // session id, both of which are derived above.
  const transcript = useTranscriptPin(displayMessages.length, activeSession?.id);

  return { activeRunOwner, activeRun, pendingUserMessage, threadRunning, displayMessages, transcript };
}
