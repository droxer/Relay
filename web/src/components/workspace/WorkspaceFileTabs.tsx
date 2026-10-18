"use client";

import { useTranslation } from "react-i18next";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { WorkspaceFileTab } from "../../lib/workspaceFileTabs";

/** The Artifacts / Activity switch at the head of the workspace file browser.
 *
 *  A toggle group, not tabs and not radios: this switches which area of one
 *  workspace is on screen, and nothing is submitted. `value` is an array
 *  because a toggle group can be multi-select; this one is not, so it holds
 *  at most the active tab, and an attempt to unpress the active item is
 *  ignored rather than leaving no tab at all. */
export function WorkspaceFileTabs({
  tab,
  onSelect,
  projectFiles = false,
}: {
  /** Null when the browse path sits outside both areas — the workspace root
   *  reached from the path bar — so neither item claims what is on screen. */
  tab: WorkspaceFileTab | null;
  onSelect: (tab: WorkspaceFileTab) => void;
  /** A project's directory is its deliverable location, so its first area
   *  is the project's files, not an `artifacts/` folder. */
  projectFiles?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      className="workspace-files-tabs"
      aria-label={t("workspace.files_sections")}
      value={tab ? [tab] : []}
      onValueChange={(next) => {
        const picked = next[0];
        if (picked) onSelect(picked as WorkspaceFileTab);
      }}
    >
      <ToggleGroupItem
        value="artifacts"
        className={`workspace-files-tab${tab === "artifacts" ? " is-active" : ""}`}
      >
        {t(projectFiles ? "workspace.tab_files" : "workspace.tab_artifacts")}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="activities"
        className={`workspace-files-tab${tab === "activities" ? " is-active" : ""}`}
      >
        {t("workspace.tab_activity")}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
