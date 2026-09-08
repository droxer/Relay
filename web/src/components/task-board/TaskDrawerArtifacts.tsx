"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listTaskArtifacts } from "../../api";
import { artifactRawHref } from "../../lib/artifactPreview";
import { useArtifactViewer } from "../ArtifactViewerProvider";
import type { ArtifactIndexItem } from "../../types";
import { Button } from "@/components/ui/button";

function taskArtifactDate(value: string | undefined, locale: string): string {
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

export function TaskDrawerArtifacts({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { open } = useArtifactViewer();
  const [artifacts, setArtifacts] = useState<ArtifactIndexItem[] | null>(null);
  const [allVersions, setAllVersions] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setArtifacts(null);
    setFailed(false);
    listTaskArtifacts(taskId, controller.signal, allVersions)
      .then((response) => setArtifacts(response.artifacts))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [taskId, allVersions]);

  return (
    <section className="task-drawer-artifacts" aria-label={t("backlog.artifacts")}>
      <h3 className="task-drawer-artifacts-title">
        {t("backlog.artifacts")}
        {artifacts && artifacts.length > 0 ? (
          <span className="task-drawer-artifacts-count tnum">{artifacts.length}</span>
        ) : null}
      </h3>
      <Button variant="ghost" type="button" aria-pressed={allVersions} onClick={() => setAllVersions(!allVersions)}>
        {t(allVersions ? "backlog.artifacts_latest" : "backlog.artifacts_versions")}
      </Button>
      {failed ? (
        <p className="task-drawer-artifacts-empty" role="alert">{t("backlog.artifacts_error")}</p>
      ) : artifacts === null ? (
        <p className="task-drawer-artifacts-empty" role="status" aria-live="polite">{t("backlog.artifacts_loading")}</p>
      ) : artifacts.length === 0 ? (
        <p className="task-drawer-artifacts-empty">{t("backlog.artifacts_empty")}</p>
      ) : (
        <ul className="task-drawer-artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="task-drawer-artifact">
              <Button variant="ghost"
                type="button"
                className="task-drawer-artifact-main"
                // Opened over TaskDrawer — declare the stack layer explicitly
                // so its backdrop z-index clears the drawer beneath it.
                onClick={() => open(artifact, artifact.sessionId, artifacts ?? [artifact], 1)}
                title={t("artifact.view_named", { title: artifact.title })}
              >
                <span className={`artifact-kind-tag is-${artifact.kind}`}>
                  {t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind })}
                </span>
                <span className="task-drawer-artifact-name">{artifact.title}</span>
                <span className="task-drawer-artifact-meta tnum">
                  {taskArtifactDate(artifact.createdAt, i18n.language)}
                </span>
              </Button>
              <a
                className="task-drawer-artifact-download"
                href={artifactRawHref(artifact.sessionId, artifact.id)}
                target="_blank"
                rel="noreferrer"
                download={artifact.title}
              >
                {t("backlog.artifact_download")}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
