"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { openProjectLeadConversation } from "../api-client/project-manager";
import { projectLeadTopicPrompt, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import type { CurrentUser } from "../types";
import { seedComposerDraft, threadDraftKey } from "./useComposer";
import { useMutationError } from "./useMutationError";
import { PROJECTS_QUERY_KEY, SESSIONS_QUERY_KEY } from "./useRelayData";

/** Opens the Project's lead Thread from its dashboard, optionally with a
 *  topic's question waiting in the composer. The Thread is the Project's one
 *  lead conversation (`POST /projects/{id}/manager/conversation`), so every
 *  quick discussion lands in the same place and nothing is sent for the
 *  person. */
export function useProjectLeadDiscussion({ projectId, currentUser, onOpenThread }: {
  projectId: string;
  currentUser: CurrentUser;
  onOpenThread: (sessionId: string) => void;
}): { discuss: (topic?: ProjectLeadTopic) => void; pending: boolean } {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { reportMutationError } = useMutationError();
  const mutation = useMutation({
    mutationFn: async (topic: ProjectLeadTopic | undefined) => {
      const { threadId } = await openProjectLeadConversation(projectId);
      /* The shell keeps a lead Thread open only once the project list names
         it (`managerThreadId`); before that it reads as an ordinary project
         thread and is sent back to the project page. */
      await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
      return { threadId, topic };
    },
    onSuccess: ({ threadId, topic }) => {
      if (topic) seedComposerDraft(threadDraftKey(currentUser, threadId), projectLeadTopicPrompt(t, topic));
      onOpenThread(threadId);
    },
    onError: (error) => reportMutationError("Failed to open the Project Lead discussion", error, t("errors.open_project_lead")),
  });
  return {
    discuss: (topic) => { if (!mutation.isPending) mutation.mutate(topic); },
    pending: mutation.isPending,
  };
}
