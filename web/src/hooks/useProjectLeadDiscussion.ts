"use client";

import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { openProjectLeadConversation } from "../api-client/project-manager";
import { projectLeadTopicPrompt, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import type { CurrentUser } from "../types";
import { seedComposerDraft, threadDraftKey } from "./useComposer";
import { useMutationError } from "./useMutationError";
import { SESSIONS_QUERY_KEY } from "./useRelayData";
import { PROJECT_DISCUSSIONS_QUERY_KEY } from "./useProjectDiscussions";
import { retainThreadDispatchView } from "../lib/threadDispatchView";

/** Starts a new Project Conversation with an optional unsent topic draft. */
export function useProjectLeadDiscussion({ projectId, currentUser, onOpenThread }: {
  projectId: string;
  currentUser: CurrentUser;
  onOpenThread: (sessionId: string) => void;
}): { discuss: (topic?: ProjectLeadTopic) => void; pending: boolean } {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { reportMutationError } = useMutationError();
  const filter = { mutationKey: ["project-lead-discussion", projectId], exact: true };
  const pending = useIsMutating(filter) > 0;
  const mutation = useMutation({
    mutationKey: filter.mutationKey,
    mutationFn: ({ projectId }: { projectId: string; user: CurrentUser; draft?: string }) =>
      openProjectLeadConversation(projectId),
    onSuccess: ({ threadId }, { projectId, user, draft }) => {
      if (draft) seedComposerDraft(threadDraftKey(user, threadId), draft);
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: [...PROJECT_DISCUSSIONS_QUERY_KEY, projectId] });
    },
    onError: (error) => reportMutationError("Failed to open the Project Lead discussion", error, t("errors.open_project_lead")),
  });
  async function discuss(topic?: ProjectLeadTopic) {
    if (queryClient.isMutating(filter)) return;
    const view = retainThreadDispatchView();
    try {
      await mutation.mutateAsync(
        { projectId, user: currentUser, draft: topic ? projectLeadTopicPrompt(t, topic) : undefined },
        // Per-call callbacks are scoped to the mounted observer. The receipt
        // still updates the original Project if the dashboard has closed.
        { onSuccess: ({ threadId }) => { if (view.isCurrent()) onOpenThread(threadId); } },
      );
    } catch {
      // The mutation reports the failure.
    } finally {
      view.release();
    }
  }
  return { discuss: (topic) => { void discuss(topic); }, pending };
}
