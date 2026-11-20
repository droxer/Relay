import type { SkillRecord } from "../domain-types/skills.js";

/**
 * A band of the skills library: the folder a skill's bundle sits in.
 *
 * A repository import publishes every SKILL.md it finds, each with its own
 * bundle path (`sourceRef.subpath`, e.g. `skills/engineering/tdd`), so a large
 * repository lands as dozens of flat rows. Banding by the bundle's parent
 * folder (`skills/engineering`) gives them back the shape the author gave
 * them. A bundle at a repository's root has no parent folder inside it, so it
 * bands under the repository itself.
 *
 * Uploads carry no folder: the browser strips the picked directory's path
 * before sending. They band by namespace, and an upload without one falls in
 * a trailing band whose label the caller translates.
 */
export interface SkillFolderGroup {
  key: string;
  /** Parent folder path, the repository, or the namespace; `null` for the
      un-namespaced uploads band. */
  label: string | null;
  /** The repository a folder belongs to, set only when two repositories
      share a folder label so the bands would otherwise read the same. */
  repository: string | null;
  skills: SkillRecord[];
}

const UPLOADS_KEY = "upload:";

/** `owner/repo` from a repository URL; the URL itself if it does not parse. */
export function repositoryName(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`;
  } catch {
    // Not a URL: show what was recorded.
  }
  return url;
}

/** The parent folder of a bundle path; empty for a bundle at the root. */
export function parentFolder(subpath: string): string {
  const parts = subpath.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

interface Placement { key: string; label: string | null; repository: string | null }

function placementOf(skill: SkillRecord): Placement {
  const source = skill.source === "git" ? skill.sourceRef : null;
  if (source) {
    const repository = repositoryName(source.url);
    const folder = parentFolder(source.subpath);
    return { key: `git:${repository}:${folder}`, label: folder || repository, repository };
  }
  const namespace = skill.namespace || "";
  return { key: `${UPLOADS_KEY}${namespace}`, label: namespace || null, repository: null };
}

const byName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base" });

export function groupSkillsByFolder(skills: readonly SkillRecord[]): SkillFolderGroup[] {
  const groups = new Map<string, SkillFolderGroup & { source: string | null }>();
  for (const skill of skills) {
    const { key, label, repository } = placementOf(skill);
    const group = groups.get(key);
    if (group) group.skills.push(skill);
    else groups.set(key, { key, label, repository: null, source: repository, skills: [skill] });
  }
  const all = [...groups.values()];
  const labelCounts = new Map<string, number>();
  for (const group of all) {
    if (group.label !== null) labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1);
  }
  return all
    .map(({ source, ...group }) => ({
      ...group,
      // A root bundle's label already is the repository; only a shared folder
      // name needs it spelled out.
      repository: source && group.label !== source && (labelCounts.get(group.label ?? "") ?? 0) > 1
        ? source
        : null,
      skills: [...group.skills].sort((left, right) => byName(left.displayName, right.displayName)),
    }))
    .sort((left, right) => {
      if (left.label === null || right.label === null) return left.label === null ? 1 : -1;
      return byName(left.label, right.label)
        || byName(left.repository ?? "", right.repository ?? "")
        || left.key.localeCompare(right.key);
    });
}
