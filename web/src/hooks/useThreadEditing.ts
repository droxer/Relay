"use client";

import type { TFunction } from "i18next";
import { useDialogs } from "../components/ui/DialogProvider";
import { useRelayMutations } from "./useRelayMutations";
import type { RelaySession } from "../types";

interface ThreadEditingInput {
  threads: RelaySession[];
  activeSessionId: string | undefined;
  token: string | undefined;
  /** Called after the open thread is deleted outright (not left pending). */
  onActiveThreadDeleted: () => void;
  t: TFunction;
}

/** Rename and delete for the thread rail, each behind its own dialog. A
    failed mutation surfaces through the mutation's own onError toast. */
export function useThreadEditing({ threads, activeSessionId, token, onActiveThreadDeleted, t }: ThreadEditingInput) {
  const { prompt, confirm } = useDialogs();
  const { renameSessionMutation, deleteSessionMutation } = useRelayMutations();

  async function renameThread(session: RelaySession) {
    const current = session.title?.trim() || session.taskGoal;
    const result = await prompt({
      title: t("thread.rename_prompt"),
      defaultValue: current,
      confirmLabel: t("thread.rename"),
    });
    const next = result?.trim();
    if (!next || next === current) return;
    try {
      await renameSessionMutation.mutateAsync({ sessionId: session.id, title: next, token });
    } catch {
      // mutation onError surfaces a toast.
    }
  }

  async function deleteThread(sessionId: string) {
    const session = threads.find((s) => s.id === sessionId);
    const label = session ? (session.title?.trim() || session.taskGoal) : sessionId;
    const ok = await confirm({
      title: t("thread.delete_confirm", { name: label }),
      message: t("thread.delete_message"),
      confirmLabel: t("thread.stop_and_delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      const pending = await deleteSessionMutation.mutateAsync({ sessionId, token });
      if (!pending && activeSessionId === sessionId) onActiveThreadDeleted();
    } catch {
      // mutation onError surfaces a toast.
    }
  }

  return { renameThread, deleteThread };
}
