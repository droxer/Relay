"use client";

import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listTaskArtifacts } from "../../api";
import { RELAY_POLL_INTERVALS_MS } from "../../lib/relayPolling";
import { RecordFailure } from "./RecordFailure";
import { artifactFileName, artifactRowFolder, artifactShowsKind, formatArtifactDate } from "../../lib/artifactPreview";
import { formatBytes } from "../../lib/workspaceFormat";
import { ArtifactKindIcon } from "../artifact/ArtifactIndexStrip";
import { ICON } from "../icons";
import type { ArtifactIndexItem } from "../../types";
import { Button } from "@/components/ui/button";

/* The viewers behind a preview (code, PDF, Markdown) load with the first
   file shown, never with the record. */
const RecordArtifactPreview = lazy(() => import("./RecordArtifactPreview").then((m) => ({ default: m.RecordArtifactPreview })));

/** What a task's runs produced: the files on the left, the picked one read
 *  in place on the right. A narrow pane shows one at a time — picking a file
 *  swaps the list for it, and the preview's back returns to the list.
 *
 *  It used to be a bare list whose rows opened a second, full-width drawer
 *  over the record, so reading a file hid the task it belonged to and
 *  telling two files apart meant hovering a rail of identical icons. */
export function RecordArtifacts({ taskId, artifactsDir }: {
  taskId: string;
  /** The task's deliverables folder. Every file under it would otherwise
   *  repeat the same folder name, so a row names only what lies beyond it. */
  artifactsDir?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [allVersions, setAllVersions] = useState(false);
  /* Keep the pick when returning to the list on a narrow pane. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  /* Cached like every other read, and `keepPreviousData` so the versions
     toggle refines the list in place instead of restarting it as a spinner. */
  const artifactsQuery = useQuery({
    queryKey: ["task-artifacts", taskId, allVersions],
    queryFn: ({ signal }) => listTaskArtifacts(taskId, signal, allVersions),
    placeholderData: keepPreviousData,
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  const artifacts: ArtifactIndexItem[] | undefined = artifactsQuery.data?.artifacts;
  const selected = artifacts?.find((artifact) => artifact.id === selectedId) ?? artifacts?.[0] ?? null;
  const reading = previewOpen && selectedId !== null && selected?.id === selectedId;

  useEffect(() => {
    if (!reading && selectedId !== null) {
      listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    }
  }, [reading, selectedId]);

  /* Up and down walk the list the way they walk a file explorer. */
  function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (!artifacts || !selected || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const index = artifacts.findIndex((artifact) => artifact.id === selected.id);
    const next = artifacts[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    setSelectedId(next.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-artifact-id]")[
      index + (event.key === "ArrowDown" ? 1 : -1)
    ]?.focus();
  }

  if (artifactsQuery.isError || !artifacts || artifacts.length === 0) {
    return (
      <section className="record-artifacts is-message" aria-label={t("backlog.artifacts")}>
        {artifactsQuery.isError ? (
          <RecordFailure message={t("backlog.artifacts_error")} onRetry={() => void artifactsQuery.refetch()} />
        ) : !artifacts ? (
          <p className="record-panel-note" role="status" aria-live="polite">{t("backlog.artifacts_loading")}</p>
        ) : (
          <p className="record-panel-note">{t("backlog.artifacts_empty")}</p>
        )}
      </section>
    );
  }

  return (
    <section className={`record-artifacts${reading ? " is-reading" : ""}`} aria-label={t("backlog.artifacts")}>
      <div className="record-artifacts-list">
        <div className="record-artifacts-head">
          <span className="record-artifacts-count tnum">{t("backlog.files_count", { count: artifacts.length })}</span>
          <Button variant="ghost" size="dense" type="button" aria-pressed={allVersions} onClick={() => setAllVersions(!allVersions)}>
            {t(allVersions ? "backlog.artifacts_latest" : "backlog.artifacts_versions")}
          </Button>
        </div>
        <ul ref={listRef} className="record-artifacts-rows" onKeyDown={handleListKeyDown}>
          {artifacts.map((artifact) => {
            const fileName = artifactFileName(artifact);
            const folder = artifact.kind === "workspace_file" ? artifactRowFolder(fileName, artifactsDir) : "";
            /* When it was made leads: an automation's files share a stem and
               differ by run, so the date is what tells two rows apart. */
            const meta = [formatArtifactDate(artifact.createdAt, i18n.language), formatBytes(artifact.bytes, i18n.language), folder]
              .filter(Boolean)
              .join(" · ");
            const isSelected = artifact.id === selected?.id;
            return (
              <li key={artifact.id}>
                <button
                  type="button"
                  className="record-artifact-row"
                  data-artifact-id={artifact.id}
                  aria-current={isSelected || undefined}
                  tabIndex={isSelected ? 0 : -1}
                  title={fileName}
                  onClick={() => { setSelectedId(artifact.id); setPreviewOpen(true); }}
                >
                  <span className="record-artifact-icon" aria-hidden="true">
                    <ArtifactKindIcon kind={artifact.kind} size={ICON.md} name={fileName} />
                  </span>
                  <span className="record-artifact-copy">
                    <span className="record-artifact-name">{artifact.title}</span>
                    <span className="record-artifact-meta tnum">
                      {artifactShowsKind(artifact.kind) ? (
                        <span className={`artifact-kind-tag is-${artifact.kind}`}>
                          {t(`artifact.kind.${artifact.kind}`, { defaultValue: artifact.kind })}
                        </span>
                      ) : null}
                      <span className="record-artifact-meta-text">{meta}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {selected ? (
        <Suspense fallback={<p className="artifact-preview-status" role="status">{t("backlog.artifacts_loading")}</p>}>
          <RecordArtifactPreview key={selected.id} artifact={selected} onBack={() => setPreviewOpen(false)} />
        </Suspense>
      ) : null}
    </section>
  );
}
