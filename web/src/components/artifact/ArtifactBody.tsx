import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";

import { readArtifactBlob } from "../../api";
import {
  artifactFileName,
  artifactRawHref,
  artifactRenderMode,
  workspaceFilePreviewMode,
} from "../../lib/artifactPreview";
import { useArtifactBody } from "../../lib/useArtifactBody";
import { CodeView, languageForFile } from "../CodeView";
import { Markdown } from "../LazyMarkdown";
import type { ArtifactView } from "./ArtifactViewToggle";

type DiffLineKind = "add" | "del" | "meta" | "hunk" | "context";

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Unified diff with per-line add/delete coloring and a gutter. */
function DiffView({ text }: { text: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  return (
    <div className="artifact-diff" role="group" aria-label={t("artifact.kind.diff")}>
      {lines.map((line, index) => {
        const kind = classifyDiffLine(line);
        const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
        // The gutter draws the sign, so the text drops its own leading
        // +/-/space — it printed twice ("- -") and indented every line.
        const body = kind === "add" || kind === "del" || (kind === "context" && line.startsWith(" "))
          ? line.slice(1)
          : line;
        return (
          <div key={index} className={`artifact-diff-line is-${kind}`}>
            <span className="artifact-diff-ln" aria-hidden="true">{index + 1}</span>
            <span className="artifact-diff-sign" aria-hidden="true">{sign}</span>
            <span className="artifact-diff-text">{body || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Terminal-styled block for command logs and test output. */
function TerminalBlock({ text }: { text: string }) {
  return (
    <pre className="artifact-terminal">
      <code>{text}</code>
    </pre>
  );
}

/** Plain monospace fallback for summaries, reviews, and raw agent output. */
function PlainBody({ text }: { text: string }) {
  return <pre className="artifact-plain">{text}</pre>;
}

function renderBody(artifact: RelayArtifact, text: string, view: ArtifactView) {
  switch (artifact.kind) {
    case "diff":
      return <DiffView text={text} />;
    case "command_log":
    case "test_output":
      return <TerminalBlock text={text} />;
    default:
      // Agent-authored plans, reviews, and summaries are Markdown; source view
      // keeps the plain monospace reading they have always had.
      return view === "preview" && artifactRenderMode(artifact) === "markdown" ? (
        <Markdown text={text} variant="document" />
      ) : (
        <PlainBody text={text} />
      );
  }
}

// Renders untrusted generated HTML inside a fully sandboxed iframe: no
// scripts, no same-origin access — the document can only lay itself out.
function SandboxedHtml({ html, title }: { html: string; title: string }) {
  return <iframe className="artifact-frame-preview" title={title} sandbox="" srcDoc={html} />;
}

/** Reads bytes as a `data:` URL of the given type. Not an object URL: those
 *  must be revoked, and a revoke tied to an effect cleanup fires under Strict
 *  Mode's double-invoke while the frame is still showing it. */
function blobToDataUrl(blob: Blob, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(new Blob([blob], { type }));
  });
}

/** A PDF artifact, framed from its fetched bytes — the same `data:` framing the
 *  workspace file preview uses.
 *
 *  Not `<iframe src={rawHref}>`: the raw route is a download — `attachment`,
 *  CSP `sandbox` and `frame-ancestors 'none'` — so the browser refused to frame
 *  it and the preview was blank (or became a download). */
function PdfPreview({ sessionId, artifact }: { sessionId: string; artifact: RelayArtifact }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["artifact-pdf", sessionId, artifact.id],
    queryFn: async ({ signal }) =>
      blobToDataUrl(await readArtifactBlob(sessionId, artifact.id, signal), "application/pdf"),
    staleTime: Infinity,
    gcTime: 60 * 1000,
    retry: false,
  });

  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return <p className="artifact-viewer-status artifact-viewer-error">{t("artifact.preview_error", { message })}</p>;
  }
  if (!query.data) {
    return <p className="artifact-viewer-status" role="status">{t("artifact.loading_preview")}</p>;
  }
  return <iframe className="artifact-frame-preview" src={query.data} title={artifact.title} />;
}

/** Text body of a generated workspace file. Renderable types (Markdown, HTML)
 *  answer to the view switch; everything else has only its source reading. */
function WorkspaceFileContent({
  artifact,
  text,
  view,
}: {
  artifact: RelayArtifact;
  text: string;
  view: ArtifactView;
}) {
  const name = artifactFileName(artifact);
  const renderMode = artifactRenderMode(artifact);
  if (renderMode === "none") return <pre className="artifact-plain">{text}</pre>;
  if (view === "source") return <CodeView code={text} language={languageForFile(name)} />;
  return renderMode === "html" ? (
    <SandboxedHtml html={text} title={artifact.title} />
  ) : (
    <Markdown text={text} variant="document" />
  );
}

function WorkspaceFileBody({
  artifact,
  sessionId,
  view,
}: {
  artifact: RelayArtifact;
  sessionId: string;
  view: ArtifactView;
}) {
  const { t } = useTranslation();
  const mode = workspaceFilePreviewMode(artifact.contentType);
  const rawHref = artifactRawHref(sessionId, artifact.id);
  const wantsText = mode === "html" || mode === "text";
  const query = useArtifactBody(sessionId, artifact.id, { enabled: wantsText });
  const path = artifact.workspaceRelativePath ?? artifact.path;

  if (mode === "image") {
    return (
      <div className="artifact-viewer-body">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); an agent-produced file of unknown size */}
        <img className="artifact-image-preview" src={rawHref} alt={artifact.title} loading="lazy" decoding="async" />
      </div>
    );
  }
  if (mode === "pdf") {
    return (
      <div className="artifact-viewer-body">
        <PdfPreview sessionId={sessionId} artifact={artifact} />
      </div>
    );
  }
  if (wantsText) {
    if (query.isLoading) {
      return <p className="artifact-viewer-status" role="status">{t("artifact.loading_preview")}</p>;
    }
    if (query.isSuccess && query.data?.trim()) {
      return (
        <div className="artifact-viewer-body">
          <WorkspaceFileContent artifact={artifact} text={query.data} view={view} />
        </div>
      );
    }
    // Fetch failed or came back empty: fall through to the download hint.
  }
  return (
    <div className="artifact-viewer-body">
      <p className="artifact-viewer-status" role="status">{t("artifact.workspace_file_preview")}</p>
      {path ? <pre className="artifact-plain">{path}</pre> : null}
    </div>
  );
}

export function ArtifactBody({
  artifact,
  sessionId,
  view = "preview",
}: {
  artifact: RelayArtifact;
  sessionId: string;
  /** Defaults to the rendered reading; callers that offer a view switch pass
   *  the user's choice through. */
  view?: ArtifactView;
}) {
  const { t } = useTranslation();
  const isWorkspaceFile = artifact.kind === "workspace_file";
  const query = useArtifactBody(sessionId, artifact.id, { enabled: !isWorkspaceFile });

  if (isWorkspaceFile) {
    return <WorkspaceFileBody artifact={artifact} sessionId={sessionId} view={view} />;
  }

  if (query.isLoading) {
    return <p className="artifact-viewer-status" role="status">{t("artifact.loading_preview")}</p>;
  }
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <p className="artifact-viewer-status artifact-viewer-error">
        {t("artifact.preview_error", { message })}
      </p>
    );
  }
  const text = query.data ?? "";
  if (!text.trim()) {
    return <p className="artifact-viewer-status" role="status">{t("artifact.preview_empty")}</p>;
  }
  return <div className="artifact-viewer-body">{renderBody(artifact, text, view)}</div>;
}
