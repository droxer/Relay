import type { RelayArtifact } from "relay-core";
import {
  ArtifactCommand,
  ArtifactDiff,
  ArtifactFile,
  ArtifactFileCode,
  ArtifactFileImage,
  ArtifactFileTable,
  ArtifactOutput,
  ArtifactPlan,
  ArtifactReview,
  ArtifactSummary,
  ArtifactTest,
} from "../icons";
import { extensionOf, imageMimeForFile, isMarkdownFile, languageForFile } from "../../lib/fileKinds";

const TABLE_EXTENSIONS: ReadonlySet<string> = new Set(["csv", "tsv", "xls", "xlsx"]);

/** The produced-file glyph for a file name: picture, source, table, or the
 *  plain sheet (Markdown and everything unrecognised). */
export function WorkspaceFileIcon({ name, size }: { name: string; size: number }) {
  if (imageMimeForFile(name)) return <ArtifactFileImage size={size} />;
  if (TABLE_EXTENSIONS.has(extensionOf(name))) return <ArtifactFileTable size={size} />;
  if (!isMarkdownFile(name) && languageForFile(name)) return <ArtifactFileCode size={size} />;
  return <ArtifactFile size={size} />;
}

export function ArtifactKindIcon({ kind, size, name }: {
  kind: RelayArtifact["kind"];
  size: number;
  /** A workspace file's name, which picks its family's glyph. */
  name?: string;
}) {
  switch (kind) {
    case "plan":
      return <ArtifactPlan size={size} />;
    case "diff":
      return <ArtifactDiff size={size} />;
    case "review":
      return <ArtifactReview size={size} />;
    case "test_output":
      return <ArtifactTest size={size} />;
    case "command_log":
      return <ArtifactCommand size={size} />;
    case "summary":
      return <ArtifactSummary size={size} />;
    case "agent_output":
      return <ArtifactOutput size={size} />;
    case "workspace_file":
      return name ? <WorkspaceFileIcon name={name} size={size} /> : <ArtifactFile size={size} />;
  }
}
