"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { readSkillFile } from "../api";
import { SKILLS_QUERY_KEY, useSkill } from "../hooks/useSkills";
import { Drawer } from "@/components/ui/Drawer";

export interface SkillPreviewDrawerProps {
  skillId: string;
  /** Name to print while the catalog record is still loading. */
  fallbackTitle: string;
  /** Which bundle the agent actually gets, so the preview shows that text. */
  channel?: "stable" | "latest";
  onClose: () => void;
}

/** The file an agent reads first; every bundle is required to carry one. */
const ENTRY_FILE = "SKILL.md";

/**
 * Read-only look at what a granted skill actually tells the agent.
 *
 * The bundle is the record: its instructions are the thing worth reading, so
 * the drawer opens on SKILL.md and lets the viewer step through the rest of
 * the files. Nothing here writes — granting and revoking stay on the panels
 * that own those actions.
 */
export function SkillPreviewDrawer({
  skillId,
  fallbackTitle,
  channel = "stable",
  onClose,
}: SkillPreviewDrawerProps) {
  const { t, i18n } = useTranslation();
  const errorText = (value: unknown) => {
    const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
      ? value.code
      : value instanceof Error ? value.message : "unknown";
    return t(`skills.errors.${code}`, { defaultValue: t("skills.errors.unknown") });
  };
  const detailQuery = useSkill(skillId);
  const skill = detailQuery.data;
  const [path, setPath] = useState(ENTRY_FILE);

  // Land on the entry file, or the first one the bundle does carry.
  useEffect(() => {
    if (!skill) return;
    if (skill.files.some((file) => file.path === path)) return;
    setPath(skill.files[0]?.path ?? ENTRY_FILE);
  }, [skill, path]);

  const fileQuery = useQuery({
    queryKey: [SKILLS_QUERY_KEY, skillId, "file", channel, path],
    queryFn: ({ signal }) => readSkillFile(skillId, path, channel, signal),
    enabled: Boolean(skill?.files.some((file) => file.path === path)),
  });
  const file = fileQuery.data;
  const bytes = (value: number) => t("skills.bytes", {
    count: value,
    value: value.toLocaleString(i18n.language),
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={skill?.displayName || fallbackTitle}
      subtitle={skill ? skill.slug : undefined}
      subtitleMono
      kicker={t("skills.preview_kicker")}
      closeLabel={t("skills.close")}
      width="wide"
      bodyClassName="skill-drawer skill-preview"
    >
      {detailQuery.isLoading ? (
        <p className="skill-muted" role="status">{t("skills.loading_detail")}</p>
      ) : detailQuery.error ? (
        <p className="skill-muted" role="alert">{errorText(detailQuery.error)}</p>
      ) : skill ? (
        <>
          {skill.description ? <p className="skill-description">{skill.description}</p> : null}
          {/* One meta line, not a stat grid: the drawer is a reading view, and
              the numbers only say which bundle is on screen. */}
          <p className="skill-muted">
            {t("skills.preview_revision", {
              revision: skill.revisions[0]?.revision ?? 1,
              channel: t(`skills.channel.${channel}`),
            })}
            {" · "}
            {t("skills.file_count", { count: skill.files.length })}
          </p>
          {/* One framed viewer: the file strip is its title bar, so switching
              files never moves the reading pane. */}
          <div className="skill-preview-viewer">
            <div className="skill-preview-bar">
              {skill.files.length > 1 ? (
                <div className="skill-preview-files" role="tablist" aria-label={t("skills.bundle")}>
                  {skill.files.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      role="tab"
                      aria-selected={entry.path === path}
                      className={`skill-preview-file code${entry.path === path ? " is-active" : ""}`}
                      onClick={() => setPath(entry.path)}
                    >
                      {entry.path}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="skill-preview-path code" translate="no">{path}</span>
              )}
              {file ? <span className="skill-preview-bytes">{bytes(file.bytes)}</span> : null}
            </div>
            {fileQuery.isLoading ? (
              <p className="skill-preview-state" role="status">{t("skills.preview_loading")}</p>
            ) : fileQuery.error ? (
              <p className="skill-preview-state" role="alert">{errorText(fileQuery.error)}</p>
            ) : file?.binary ? (
              <p className="skill-preview-state">{t("skills.preview_binary")}</p>
            ) : file ? (
              <pre className="skill-preview-content"><code>{file.content}</code></pre>
            ) : null}
          </div>
          {file?.truncated ? (
            <p className="skill-muted">{t("skills.preview_truncated")}</p>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
