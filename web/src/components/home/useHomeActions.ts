"use client";

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { updateUserPreferences } from "../../api-client/auth";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useMutationError } from "../../hooks/useMutationError";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { taskStartMutationInput } from "../../lib/taskBoardForm";
import type { HomeItem } from "../../lib/homeQueue";
import type { CurrentUser, RelayTaskListItem, StartTaskResponse } from "../../types";

/** What Home does without leaving the page: snooze a queue row and start a
 *  ready task. Answering, approving, and accepting happen in the thread or
 *  record a row opens, never from Home. Snooze resolves true when it landed. */
export interface HomeActions {
  startTask: (task: RelayTaskListItem) => Promise<StartTaskResponse>;
  snooze: (item: HomeItem) => Promise<boolean>;
}

export function useHomeActions(setUser: (user: CurrentUser) => void): HomeActions {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();
  const { startTaskMutation } = useRelayMutations();

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

  return { snooze, startTask };
}
