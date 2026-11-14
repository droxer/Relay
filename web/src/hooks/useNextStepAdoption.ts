import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { NextStepAdoption } from "../components/NextSteps";
import { adoptedNextStepTask, nextStepTaskInput } from "../lib/nextSteps.ts";
import type { RelayTaskListItem } from "../types";
import type { OpenTaskRecord } from "./useTaskThreadLifecycle";
import { useRelayMutations } from "./useRelayMutations";

/**
 * How a thread's suggested next steps become tasks: in the thread's project
 * when it has one — so project work stays in the project's tasks — and as an
 * issue with no project otherwise. Undefined where the person cannot add work
 * (a project they only read), so the Adopt control is not offered at all.
 */
export function useNextStepAdoption({ projectId, projectName, readOnly, tasks, onOpenTaskRecord }: {
  projectId: string | null;
  projectName: string | null;
  readOnly: boolean;
  tasks: readonly RelayTaskListItem[];
  onOpenTaskRecord: OpenTaskRecord;
}): NextStepAdoption | undefined {
  const { t } = useTranslation();
  const { createTaskMutation } = useRelayMutations();
  const { mutateAsync } = createTaskMutation;
  return useMemo(() => {
    if (readOnly) return undefined;
    return {
      // A project whose record has not loaded is still named as a project.
      projectName: projectId ? projectName ?? t("next_steps.this_project") : null,
      adoptedTask: (step) => adoptedNextStepTask(step, tasks, projectId),
      onAdopt: (step) => mutateAsync(nextStepTaskInput(step, projectId)),
      onOpenTask: (task) => onOpenTaskRecord({ taskId: task.id }),
    };
  }, [readOnly, projectId, projectName, tasks, mutateAsync, onOpenTaskRecord, t]);
}
