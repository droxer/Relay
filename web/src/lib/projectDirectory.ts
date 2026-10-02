/**
 * Pure state helpers for the projects directory rail — which folders are open,
 * what the collapsed folder's aggregate dot says, and which empty line (if any)
 * a folder with no visible threads should print.
 *
 * The panel keeps none of this in component state: expansion survives reloads
 * through localStorage, and the tone/empty-line rules are decisions worth
 * testing away from the DOM.
 */

import type { ProjectRecord } from "../types.js";
import type { ProjectCollectionStatus } from "./projectPage.js";

/** Apply a project mutation result before its background collection refetch. */
export function mergeProjectIntoProjects(
  projects: ProjectRecord[],
  project: ProjectRecord,
): ProjectRecord[] {
  return [...projects.filter((entry) => entry.id !== project.id), project].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export const projectExpansionKey = "relay-web.projectExpansion";

/** Explicit per-project choices only. An id absent from the record has never
 *  been toggled and falls back to the archived-aware default, so a newly
 *  created project opens without needing a write. */
type ProjectExpansion = Record<string, boolean>;

type ProjectFolderTone = "attn" | "run";

/** Active projects open, archived ones stay shut — until the user says
 *  otherwise, and then their choice outranks both defaults. */
export function isProjectExpanded(project: ProjectRecord, expansion: ProjectExpansion): boolean {
  return expansion[project.id] ?? !project.archivedAt;
}

export function toggleProjectExpansion(
  expansion: ProjectExpansion,
  project: ProjectRecord,
): ProjectExpansion {
  return { ...expansion, [project.id]: !isProjectExpanded(project, expansion) };
}

/** Selecting a project opens it. Distinct from forcing it open: the record is
 *  a normal explicit choice afterwards, so the chevron still works. */
export function expandProject(expansion: ProjectExpansion, projectId: string): ProjectExpansion {
  if (expansion[projectId] === true) return expansion;
  return { ...expansion, [projectId]: true };
}

export function readProjectExpansion(): ProjectExpansion {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(projectExpansionKey) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Stored state is user-writable and outlives any given release: keep the
    // entries that still make sense and drop the rest rather than trusting it.
    const clean: ProjectExpansion = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") clean[id] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeProjectExpansion(expansion: ProjectExpansion): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(projectExpansionKey, JSON.stringify(expansion));
  } catch {
    /* storage unavailable — expansion simply resets on the next load */
  }
}

/** The one signal a collapsed folder gets for the threads it is hiding.
 *  Expanded, every row already carries its own pip, so the folder says
 *  nothing — restating the loudest child would be the same fact twice. */
export function projectFolderTone(
  { needsYou, running, expanded }: { needsYou: number; running: number; expanded: boolean },
): ProjectFolderTone | undefined {
  if (expanded) return undefined;
  if (needsYou > 0) return "attn";
  if (running > 0) return "run";
  return undefined;
}

/** What a folder should say about being on the current route.
 *
 *  Opening a thread routes to its project too, so "this project is selected"
 *  and "a thread in this project is selected" are both true at once. Only the
 *  innermost one is the selection — the folder steps back to "ancestor" and
 *  lets the thread row carry the wash, otherwise a single click reads as
 *  three selected rows. */
export function projectFolderSelection(
  { projectId, selectedProjectId, selectedSessionId, threadIds }: {
    projectId: string;
    selectedProjectId: string | null;
    selectedSessionId: string | undefined;
    threadIds: readonly string[];
  },
): "selected" | "ancestor" | null {
  if (selectedProjectId !== projectId) return null;
  // Matched against this folder's own threads, not merely "some thread is
  // open": the open thread can belong elsewhere while this project is the
  // route's destination.
  if (selectedSessionId && threadIds.includes(selectedSessionId)) return "ancestor";
  return "selected";
}

/** A folder showing no threads either has none, or has none that match the
 *  search. Only the second case is worth a sentence: in the first the count
 *  badge already reads 0, and "no threads yet" would be false in the second. */
export function projectEmptyKey(
  { threadCount, hasQuery }: { threadCount: number; hasQuery: boolean },
): "project.no_matching_threads" | null {
  if (threadCount > 0) return null;
  return hasQuery ? "project.no_matching_threads" : null;
}

type ProjectDirectoryState = "loading" | "error" | "empty" | "filtered-empty" | "ready";

/** What the projects rail should show in place of its folders.
 *
 *  The rail lists the same collection the project detail pane resolves through
 *  resolveProjectOverviewState, and that pane already separates loading from
 *  error from not-found. The rail used to fold all three into "No projects yet
 *  · Create project", so a slow or failed fetch read as an empty account and
 *  invited the user to create a project they might already own.
 *
 *  Existing folders win over every non-ready status on purpose: the projects
 *  query refetches on a poll interval, so a populated rail re-enters "loading"
 *  regularly and blanking it to a spinner each time would be its own defect. */
export function projectDirectoryState(
  { projectCount, collectionStatus, hasQuery }: {
    projectCount: number;
    collectionStatus: ProjectCollectionStatus;
    hasQuery: boolean;
  },
): ProjectDirectoryState {
  if (projectCount > 0) return "ready";
  if (collectionStatus === "loading") return "loading";
  // A failure outranks the search explanation — the query did not empty the
  // list, the request did, and saying "no matches" would blame the wrong thing.
  if (collectionStatus === "error") return "error";
  return hasQuery ? "filtered-empty" : "empty";
}
