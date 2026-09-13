"use client";
import { useQuery } from "@tanstack/react-query";
import { getSkill, listSkills } from "../api";
export const SKILLS_QUERY_KEY = "skills";
export function useSkills() { return useQuery({ queryKey: [SKILLS_QUERY_KEY], queryFn: ({ signal }) => listSkills(signal) }); }
export function useSkill(skillId: string | null) { return useQuery({ queryKey: [SKILLS_QUERY_KEY, skillId], queryFn: ({ signal }) => getSkill(skillId!, signal), enabled: Boolean(skillId) }); }
