"use client";

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { updateUserPreferences } from "../../api-client/auth";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useMutationError } from "../../hooks/useMutationError";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { taskStartMutationInput } from "../../lib/taskBoardForm";
import type { HomeItem } from "../../lib/homeQueue";
import type { CurrentUser, RelaySession, RelayTaskListItem, StartTaskResponse } from "../../types";

/** What a Home row can do without leaving the page. Each one is the same
 *  call the thread or task record makes, so Home adds no write path of its
 *  own; anything richer (a written denial note, a multi-question prompt)
 *  opens the record instead. Every action resolves true when it landed. */
export interface HomeActions {
  startTask: (task: RelayTaskListItem) => Promise<StartTaskResponse>;
  answerPermission: (session: RelaySession, requestId: string, decision: "allow" | "deny", always?: boolean) => Promise<boolean>;
  answerWait: (sessionId: string, questionId: string | null, text: string, approve?: boolean) => Promise<boolean>;
  acceptReview: (task: RelayTaskListItem) => Promise<boolean>;
  sendStep: (session: RelaySession, step: string) => Promise<boolean>;
  snooze: (item: HomeItem) => Promise<boolean>;
}

export function useHomeActions(setUser: (user: CurrentUser) => void): HomeActions {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();
  const { answerPermissionMutation, submitThreadMessageMutation, updateTaskMutation, startTaskMutation } = useRelayMutations();

  const attempt = useCallback(async (run: () => Promise<unknown>, done: string, failed: string): Promise<boolean> => {
    try {
      await run();
      announce(done);
      return true;
    } catch (error) {
      reportMutationError(`Home: ${failed}`, error, t(failed));
      return false;
    }
  }, [announce, reportMutationError, t]);

  const answerPermission = useCallback<HomeActions["answerPermission"]>((session, requestId, decision, always) =>
    attempt(
      () => answerPermissionMutation.mutateAsync({ sessionId: session.id, requestId, answer: { decision, ...(always ? { always: true } : {}) } }),
      t(decision === "allow" ? "home.done.allowed" : "home.done.denied"),
      "errors.answer_permission",
    ), [answerPermissionMutation, attempt, t]);

  const answerWait = useCallback<HomeActions["answerWait"]>((sessionId, questionId, text, approve) =>
    attempt(
      () => submitThreadMessageMutation.mutateAsync({
        sessionId,
        input: {
          text,
          intent: "accomplish",
          idempotencyKey: crypto.randomUUID(),
          ...(questionId ? { questionId, ...(approve ? { approve: true } : {}) } : {}),
        },
      }),
      t(approve ? "home.done.approved" : "home.done.answered"),
      "home.errors.send",
    ), [attempt, submitThreadMessageMutation, t]);

  const acceptReview = useCallback<HomeActions["acceptReview"]>((task) =>
    attempt(
      () => updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done" } }),
      t("home.done.accepted"),
      "errors.save_task",
    ), [attempt, t, updateTaskMutation]);

  const sendStep = useCallback<HomeActions["sendStep"]>((session, step) =>
    attempt(
      () => submitThreadMessageMutation.mutateAsync({
        sessionId: session.id,
        input: { text: step, intent: "accomplish", idempotencyKey: crypto.randomUUID() },
      }),
      t("home.done.sent"),
      "home.errors.send",
    ), [attempt, submitThreadMessageMutation, t]);

  const snooze = useCallback<HomeActions["snooze"]>((item) =>
    attempt(
      async () => {
        const { user } = await updateUserPreferences({ homeSnoozes: { snooze: [{ key: item.key, stamp: item.stamp }] } });
        setUser(user);
      },
      t("home.done.snoozed"),
      "home.errors.snooze",
    ), [attempt, setUser, t]);

  const startTask = useCallback<HomeActions["startTask"]>((task) =>
    startTaskMutation.mutateAsync(taskStartMutationInput(task)), [startTaskMutation]);

  return { answerPermission, answerWait, acceptReview, sendStep, snooze, startTask };
}
