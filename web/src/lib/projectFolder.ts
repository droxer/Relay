/**
 * Linking an existing folder on the project's computer as its workspace.
 *
 * The computer decides which folders may be linked (backend/relay/api/
 * project_links.py relays its answer), so the web only checks the shape the
 * backend checks and translates the computer's refusal codes.
 */

/** The daemon advertises this when it can link existing folders. */
export const PROJECT_LINKS_CAPABILITY = "project-links";

/** POSIX absolute, or a Windows drive path — mirrors `_ABSOLUTE_HOST_PATH`. */
const ABSOLUTE_FOLDER = /^(\/|[A-Za-z]:[\\/])/;

export function computerLinksFolders(computer: { capabilities?: string[] } | undefined): boolean {
  return Boolean(computer?.capabilities?.includes(PROJECT_LINKS_CAPABILITY));
}

/** True for an empty field (a new folder) or an absolute path worth asking about. */
export function folderPathLooksValid(value: string): boolean {
  const path = value.trim();
  return path === "" || ABSOLUTE_FOLDER.test(path);
}

const FOLDER_ERROR_KEYS: Record<string, string> = {
  project_workspace_path_invalid: "project.folder_invalid",
  project_workspace_invalid_path: "project.folder_invalid",
  project_workspace_not_found: "project.folder_not_found",
  project_workspace_not_directory: "project.folder_not_directory",
  project_workspace_not_allowed: "project.folder_not_allowed",
  project_workspace_not_writable: "project.folder_not_writable",
  project_workspace_protected: "project.folder_protected",
  project_workspace_link_unsupported: "project.folder_unsupported",
  project_computer_offline: "project.folder_offline",
};

/**
 * The translation key for a folder refusal, or null when the error is not
 * about the folder (it then belongs to the shared error announcement).
 */
export function projectFolderErrorKey(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = (error as Error & { code: unknown }).code;
  return typeof code === "string" ? FOLDER_ERROR_KEYS[code] ?? null : null;
}
