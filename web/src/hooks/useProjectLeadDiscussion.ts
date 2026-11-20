"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { openProjectLeadConversation } from "../api-client/project-manager";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import { projectLeadTopicPrompt, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import type { CurrentUser, UserAgent } from "../types";
import { seedComposerDraft, threadDraftKey } from "./useComposer";
import { useMutationError } from "./useMutationError";
import { SESSIONS_QUERY_KEY } from "./useRelayData";

/** Starts a new Project Conversation with an optional unsent topic draft. */
export function useProjectLeadDiscussion({ projectId, currentUser, agents, onOpenThread }: {
  projectId: string;
  currentUser: CurrentUser;
  agents: readonly Pick<UserAgent, "id" | "executorKind">[];
  onOpenThread: (sessionId: string) => void;
}): { discuss: (topic?: ProjectLeadTopic) => void; pending: boolean } {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { reportMutationError } = useMutationError();
  const mutation = useMutation({
    mutationFn: (_topic: ProjectLeadTopic | undefined) => openProjectLeadConversation(projectId),
    onSuccess: ({ threadId, agentId }, topic) => {
      const agent = agents.find(candidate => candidate.id === agentId);
      if (agent) {
        useComposerTargetStore.getState().rememberThreadPick(threadId, {
          kind: "agent", agent: { id: agent.id, executorKind: agent.executorKind },
        });
      }
      if (topic) seedComposerDraft(threadDraftKey(currentUser, threadId), projectLeadTopicPrompt(t, topic));
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
      onOpenThread(threadId);
    },
    onError: (error) => reportMutationError("Failed to open the Project Lead discussion", error, t("errors.open_project_lead")),
  });
  return {
    discuss: (topic) => { if (!mutation.isPending) mutation.mutate(topic); },
    pending: mutation.isPending,
  };
}
