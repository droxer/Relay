"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskArtifacts } from "../../api";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { RecordFailure } from "./RecordFailure";
import {
  artifactDownloadName,
  artifactRawHref,
  artifactShowsKind,
  formatArtifactDate,
} from "../../lib/artifactPreview";
import { useArtifactViewer } from "../ArtifactViewerProvider";
import type { ArtifactIndexItem } from "../../types";
import { Button } from "@/components/ui/button";

export function RecordArtifacts({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { open } = useArtifactViewer();
  const [allVersions, setAllVersions] = useState(false);

  /* Cached like every other read, and `keepPreviousData` so the versions
     toggle refines the list in place instead of restarting it as a spinner. */
  const artifactsQuery = useQuery({
    queryKey: ["task-artifacts", taskId, allVersions],
    queryFn: ({ signal }) => listTaskArtifacts(taskId, signal, allVersions),
    placeholderData: keepPreviousData,
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  const artifacts: ArtifactIndexItem[] | undefined = artifactsQuery.data?.artifacts;

  return (
    <section className="record-panel" aria-label={t("backlog.artifacts")}>
      <div className="record-panel-head">
        <h3 className="record-panel-title">
          {t("backlog.artifacts")}
          {artifacts && artifacts.length > 0 ? (
            <span className="record-panel-count tnum">{artifacts.length}</span>
          ) : null}
        </h3>
        <Button variant="ghost" size="dense" type="button" aria-pressed={allVersions} onClick={() => setAllVersions(!allVersions)}>
          {t(allVersions ? "backlog.artifacts_latest" : "backlog.artifacts_versions")}
        </Button>
      </div>
      {artifactsQuery.isError ? (
        <RecordFailure message={t("backlog.artifacts_error")} onRetry={() => void artifactsQuery.refetch()} />
      ) : !artifacts ? (
        <p className="record-panel-note" role="status" aria-live="polite">{t("backlog.artifacts_loading")}</p>
      ) : artifacts.length === 0 ? (
        <p className="record-panel-note">{t("backlog.artifacts_empty")}</p>
      ) : (
        <ul className="record-file-list">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="record-file">
              <Button variant="ghost"
                type="button"
                className="record-file-main"
                // Opened over the task record drawer (layer 0) — declare the
                // stack layer explicitly so its backdrop clears that drawer.
                onClick={() => open(artifact, artifact.sessionId, artifacts ?? [artifact], 1)}
                title={t("artifact.view_named", { title: artifact.title })}
              >
                {artifactShowsKind(artifact.kind) ? (
                  <span className={`artifact-kind-tag is-${artifact.kind}`}>
                    {t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind })}
                  </span>
                ) : null}
                <span className="record-file-name">{artifact.title}</span>
                <span className="record-file-meta tnum">
                  {formatArtifactDate(artifact.createdAt, i18n.language)}
                </span>
              </Button>
              {/* The preview header's download control, and its file name. */}
              <Button variant="ghost"
                size="dense"
                nativeButton={false}
                render={<a href={artifactRawHref(artifact.sessionId, artifact.id)} download={artifactDownloadName(artifact.title)} />}
              >
                {t("artifact.action_download")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
