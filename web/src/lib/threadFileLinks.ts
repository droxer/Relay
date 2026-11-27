import type { RelayArtifact } from "../types.js";

function filePathKey(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\/(?=[a-z]:\/)/i, "");
  const drive = /^[a-z]:\//i.exec(normalized)?.[0];
  const rest = drive ? normalized.slice(drive.length) : normalized;
  if (!rest || rest.startsWith("//") || /[:\u0000-\u001f\u007f]/.test(rest)) return undefined;
  const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.includes("..")) return undefined;
  return (drive?.toLowerCase() ?? (rest.startsWith("/") ? "/" : "")) + parts.join("/");
}

/** Turn a Markdown target into a lookup key. It is never used as a browser URL. */
export function threadFileLinkPath(href: string): string | undefined {
  const path = href.trim().split(/[?#]/, 1)[0]
    .replace(/^file:\/\/(?=\/)/i, "")
    .replace(/^sandbox:(?=\/)/i, "");
  try {
    return filePathKey(decodeURIComponent(path));
  } catch {
    return undefined;
  }
}

type FilesByPath = Map<string, RelayArtifact>;

function rememberFile(files: FilesByPath, path: string | undefined, artifact: RelayArtifact) {
  if (!path) return;
  const previous = files.get(path);
  if (!previous || artifact.createdAt >= previous.createdAt) files.set(path, artifact);
}

function rememberPaths(files: FilesByPath, artifact: RelayArtifact) {
  rememberFile(files, filePathKey(artifact.path), artifact);
  if (artifact.workspaceRelativePath) rememberFile(files, filePathKey(artifact.workspaceRelativePath), artifact);
}

export function indexThreadFileLinks(artifacts: readonly RelayArtifact[]) {
  const thread = new Map<string, RelayArtifact>();
  const runs = new Map<string, { paths: FilesByPath; names: Map<string, RelayArtifact | null> }>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "workspace_file") continue;
    rememberPaths(thread, artifact);
    if (!artifact.agentRunId) continue;
    let run = runs.get(artifact.agentRunId);
    if (!run) {
      run = { paths: new Map(), names: new Map() };
      runs.set(artifact.agentRunId, run);
    }
    rememberPaths(run.paths, artifact);
    const path = filePathKey(artifact.workspaceRelativePath ?? artifact.path);
    if (!path) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const previous = run.names.get(name);
    if (previous === null) continue;
    if (previous && filePathKey(previous.workspaceRelativePath ?? previous.path) !== path) run.names.set(name, null);
    else if (!previous || artifact.createdAt >= previous.createdAt) run.names.set(name, artifact);
  }

  return (href: string, runId: string, codexSessionId?: string): RelayArtifact | undefined => {
    const path = threadFileLinkPath(href);
    if (!path) return undefined;
    const run = runs.get(runId);
    // BoxLite uses /workspace; some runtimes describe their outputs under /mnt/data.
    const relative = path.replace(/^\/(?:workspace|mnt\/data)\//, "");
    const exact = run?.paths.get(path) ?? run?.paths.get(relative) ?? thread.get(path) ?? thread.get(relative);
    if (exact) return exact;
    if (!relative.includes("/")) return run?.names.get(relative) ?? undefined;
    // Codex may link its original image path after Relay has imported it.
    const [directory, session, name] = path.split("/").slice(-3);
    if (directory === "generated_images" && session === codexSessionId && /\.(png|gif)$/i.test(name)) {
      return run?.names.get(name) ?? undefined;
    }
    return undefined;
  };
}

export type ResolveThreadFileLink = ReturnType<typeof indexThreadFileLinks>;
