"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getSkill, getSkillRevisionPage, listSkills } from "../api";
export const SKILLS_QUERY_KEY = "skills";
export function useSkills() { return useQuery({ queryKey: [SKILLS_QUERY_KEY], queryFn: ({ signal }) => listSkills(signal) }); }
export function useSkill(skillId: string | null) { return useQuery({ queryKey: [SKILLS_QUERY_KEY, skillId], queryFn: ({ signal }) => getSkill(skillId!, signal), enabled: Boolean(skillId) }); }

export function useOlderSkillRevisions(skillId: string | null, before?: number | null) {
  return useInfiniteQuery({
    queryKey: [SKILLS_QUERY_KEY, skillId, "older-revisions", before],
    initialPageParam: before ?? 1,
    queryFn: ({ pageParam, signal }) => getSkillRevisionPage(skillId!, pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextRevisionBefore,
    enabled: false,
  });
}
