"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspaceFileResponse } from "../../types";
import { formatBytes } from "../../lib/workspaceFormat";
import { WorkspaceLoading } from "./WorkspacePrimitives";
import {
  CodeView,
  imageMimeForFile,
  isHtmlFile,
  isMarkdownFile,
  isPdfFile,
  isRenderableFile,
  languageForFile,
} from "../CodeView";
import { Markdown } from "../LazyMarkdown";
import type { ArtifactView } from "../artifact/ArtifactViewToggle";

/** Every workspace-file response (project, node, task, …) shares this shape
 *  apart from which id field names the owner — the preview never reads that
 *  field, so it accepts any response minus its owner id. */
type WorkspaceFileResponseLike = Omit<ProjectWorkspaceFileResponse, "projectId">;

/* One workspace file on screen — rendered when the type has a presentation,
   source otherwise. Shared by the full-page workspace tab and the thread
   output panel so a file reads the same wherever it is opened. */

/** Which reading a file opens on, and the reset when another file is picked.
 *
 *  Lives here, next to the preview it drives, but is owned by the PARENT: the
 *  switch sits in the file's header beside its name on both surfaces, and a
 *  header cannot read state held by its sibling body. */
export function useWorkspaceFileView(name: string): {
  view: ArtifactView;
  setView: (view: ArtifactView) => void;
} {
  const renderable = isRenderableFile(name);
  const [view, setView] = useState<ArtifactView>(renderable ? "preview" : "source");
  // Each file opens on its own default rather than carrying the last file's
  // source view onto one the reader has not looked at yet.
  useEffect(() => {
    setView(renderable ? "preview" : "source");
  }, [name, renderable]);
  return { view, setView };
}

export function WorkspaceFilePreview({
  name,
  data,
  isLoading,
  error,
  view,
}: {
  name: string;
  data?: WorkspaceFileResponseLike;
  isLoading: boolean;
  error: unknown;
  view: ArtifactView;
}) {
  const { t, i18n } = useTranslation();
  const renderable = isRenderableFile(name);
  const rendered = renderable && view === "preview";

  if (isLoading) {
    return <WorkspaceLoading label={t("workspace.loading_preview")} />;
  }
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <p className="artifact-viewer-status artifact-viewer-error">{message}</p>;
  }
  if (!data) return null;
  if (data.isBinary) {
    const imageMime = imageMimeForFile(name);
    const media = data.contentBase64
      ? imageMime
        ? { kind: "image" as const, src: `data:${imageMime};base64,${data.contentBase64}` }
        : isPdfFile(name)
          ? { kind: "pdf" as const, src: `data:application/pdf;base64,${data.contentBase64}` }
          : null
      : null;
    if (!media) {
      return <p className="artifact-viewer-status">{t("workspace.binary_file")}</p>;
    }
    return (
      <div className="workspace-preview-viewport is-bleed">
        <div className="artifact-viewer-body is-bleed">
          {media.kind === "image" ? (
            <img className="artifact-image-preview" src={media.src} alt={name} />
          ) : (
            <iframe className="artifact-frame-preview" title={name} src={media.src} />
          )}
          {data.truncated ? (
            <p className="workspace-preview-truncated">{t("workspace.file_truncated", { limit: formatBytes(data.limitBytes, i18n.language) })}</p>
          ) : null}
        </div>
      </div>
    );
  }
  if (!data.content || !data.content.trim()) {
    return <p className="artifact-viewer-status">{t("workspace.empty_file")}</p>;
  }
  const showRendered = rendered;
  const bleed = showRendered && (isMarkdownFile(name) || isHtmlFile(name));
  return (
    <div className={`workspace-preview-viewport${bleed ? " is-bleed" : ""}`}>
      <div className={`artifact-viewer-body${bleed ? " is-bleed" : ""}`}>
        {showRendered && isMarkdownFile(name) ? (
          <Markdown text={data.content} variant="document" />
        ) : showRendered && isHtmlFile(name) ? (
          <HtmlPreview html={data.content} title={name} />
        ) : (
          <CodeView code={data.content} language={languageForFile(name)} />
        )}
        {data.truncated ? (
          <p className="workspace-preview-truncated">{t("workspace.file_truncated", { limit: formatBytes(data.limitBytes, i18n.language) })}</p>
        ) : null}
      </div>
    </div>
  );
}

function HtmlPreview({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      className="html-preview"
      title={title}
      sandbox=""
      srcDoc={html}
    />
  );
}
