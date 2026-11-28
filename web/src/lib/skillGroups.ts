import type { SkillRecord } from "../domain-types/skills.js";

interface SkillGroup {
  key: string;
  label: string | null;
  qualifier: string | null;
  skills: SkillRecord[];
}

function repositoryGroup(source: SkillRecord["sourceRef"]) {
  if (!source) return null;
  try {
    const url = new URL(source.url);
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    const label = name?.replace(/\.git$/i, "");
    if (url.hostname.replace(/\.$/, "") === "github.com" && owner && label) {
      return { key: `git:${owner}/${label}`.toLowerCase(), label, owner };
    }
  } catch {
    // An old record with no usable repository still belongs in the library.
  }
  return null;
}

const byName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base" });

export function groupSkills(skills: readonly SkillRecord[]): SkillGroup[] {
  const groups = new Map<string, Omit<SkillGroup, "qualifier"> & { owner: string | null }>();
  for (const skill of skills) {
    const [namespace] = skill.namespace?.split("/") ?? [];
    const { key, label, owner } = namespace
      ? { key: `namespace:${namespace}`, label: namespace, owner: null }
      : (skill.source === "git" ? repositoryGroup(skill.sourceRef) : null)
        ?? { key: "ungrouped", label: null, owner: null };
    const group = groups.get(key);
    if (group) group.skills.push(skill);
    else groups.set(key, { key, label, owner, skills: [skill] });
  }

  const labelCounts = new Map<string, number>();
  for (const { label } of groups.values()) {
    if (label === null) continue;
    const normalized = label.toLowerCase();
    labelCounts.set(normalized, (labelCounts.get(normalized) ?? 0) + 1);
  }

  return [...groups.values()]
    .map(({ owner, ...group }) => ({
      ...group,
      qualifier: group.label && (labelCounts.get(group.label.toLowerCase()) ?? 0) > 1 ? owner : null,
      skills: group.skills.sort((left, right) => byName(left.displayName, right.displayName)),
    }))
    .sort((left, right) => {
      if (left.label === null) return 1;
      if (right.label === null) return -1;
      return byName(left.label, right.label)
        || byName(left.qualifier ?? "", right.qualifier ?? "")
        || left.key.localeCompare(right.key);
    });
}

export function searchSkillGroups(groups: SkillGroup[], query: string, ungroupedLabel: string): SkillGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups.flatMap((group) => {
    if ((group.label ?? ungroupedLabel).toLowerCase().includes(needle)) return [group];
    const skills = group.skills.filter((skill) => [
      skill.displayName, skill.name, skill.slug, skill.namespace, skill.description,
      skill.sourceRef?.url, skill.sourceRef?.subpath,
    ].some((part) => part?.toLowerCase().includes(needle)));
    return skills.length ? [{ ...group, skills }] : [];
  });
}
