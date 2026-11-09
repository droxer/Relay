"use client";

import { useTranslation } from "react-i18next";
import { setupAwaitingApply } from "../lib/projectSetup";
import type { ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";

/** Under a setup thread's last turn: the draft is done, but nothing changes
 *  until the owner applies it on the project dashboard. */
export function ProjectSetupCue({ project, threadId, onOpenProject }: {
  project: ProjectRecord | null | undefined;
  threadId: string | null | undefined;
  onOpenProject: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const setup = setupAwaitingApply(project, threadId);
  if (!project || !setup) return null;
  const plan = setup.mode === "plan";
  return (
    <div className="handoff-panel project-setup-cue" role="status" aria-live="polite">
      <div className="handoff-panel-title">{t(plan ? "project.setup_cue_plan_title" : "project.setup_cue_title")}</div>
      <p className="project-setup-cue-body">{t(plan ? "project.setup_cue_plan_body" : "project.setup_cue_body", { project: project.name })}</p>
      <div>
        <Button type="button" variant="outline" onClick={() => onOpenProject(project.id)}>
          {t("project.setup_cue_open")}
        </Button>
      </div>
    </div>
  );
}
