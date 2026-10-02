import type { RelayArtifact } from "relay-core";
import { relayApiPath } from "relay-core/api-url";

import { isHtmlFile, isMarkdownFile } from "./fileKinds.ts";

/** Raw download/streaming URL for an artifact body. */
export function artifactRawHref(sessionId: string, artifactId: string): string {
  return relayApiPath(`/threads/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`);
}

type WorkspaceFilePreviewMode = "image" | "pdf" | "html" | "text" | "none";

/** How a generated workspace file can be previewed, from its content type. */
export function workspaceFilePreviewMode(contentType: string | undefined): WorkspaceFilePreviewMode {
  const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/html") return "html";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "none";
}

/** Which rendered presentation an artifact has *in addition to* its source
 *  text. "none" means the source is the only reading of it, so the panel
 *  offers no view switch. */
type ArtifactRenderMode = "markdown" | "html" | "none";

/** Artifact kinds whose bodies agents author as Markdown. The remaining text
 *  kinds (diff, command_log, test_output, agent_output) are raw streams with
 *  their own dedicated rendering — Markdown would corrupt them. */
const MARKDOWN_KINDS: ReadonlySet<RelayArtifact["kind"]> = new Set(["plan", "review", "summary"]);

/** Best filename for an artifact — the workspace path wins over the display
 *  title, which is free text and need not carry an extension. */
export function artifactFileName(artifact: RelayArtifact): string {
  return artifact.workspaceRelativePath ?? artifact.path ?? artifact.title ?? "";
}

/** Whether the artifact renders to something other than its source, and how.
 *  Content type leads for workspace files (the daemon reports it); the
 *  filename is the fallback for the Markdown case, which arrives as a plain
 *  `text/*` type indistinguishable from a log. */
export function artifactRenderMode(artifact: RelayArtifact): ArtifactRenderMode {
  if (artifact.kind !== "workspace_file") {
    return MARKDOWN_KINDS.has(artifact.kind) ? "markdown" : "none";
  }
  const mode = workspaceFilePreviewMode(artifact.contentType);
  if (mode === "html") return "html";
  // Images and PDFs have no source reading, and binaries have no preview at
  // all — neither earns a switch.
  if (mode !== "text") return "none";
  const name = artifactFileName(artifact);
  if (isMarkdownFile(name)) return "markdown";
  if (isHtmlFile(name)) return "html";
  return "none";
}

/** A filesystem-safe download name from an artifact title. Every download
 *  control funnels through this so the same artifact saves under one name
 *  whichever surface it was downloaded from. */
export function artifactDownloadName(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "artifact";
}

/** Whether an artifact's kind tag earns its place beside its title. A plan, a
 *  diff, or a review is not named by its title; a workspace file is — "File"
 *  next to `notes.md` is noise. One rule for every list and header. */
export function artifactShowsKind(kind: RelayArtifact["kind"]): boolean {
  return kind !== "workspace_file";
}

/** Short creation stamp ("Oct 1, 14:05") that tells versions of one file
 *  apart in artifact lists. Unparseable input is returned as-is. */
export function formatArtifactDate(value: string | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
