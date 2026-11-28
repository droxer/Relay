import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { projectReadOnly } from "../../lib/projectPage";
import type { ProjectListItem } from "../../types";
import { ICON, NavProjects } from "../icons";

export type DraftProjectSelection = {
  projectId: string | null;
  projects: readonly ProjectListItem[];
  locked: boolean;
  onChange: (projectId: string | null) => void;
};

export function ThreadProjectSelect({ projectId, projects, locked, loading, onChange }: DraftProjectSelection & { loading: boolean }) {
  const { t } = useTranslation();
  const options = projects.filter(project => !projectReadOnly(project));
  const selected = options.find(project => project.id === projectId);
  const noProject = t("composer.no_project");
  const label = projectId
    ? selected?.name ?? t(loading ? "composer.project_loading" : "composer.project_unavailable")
    : noProject;
  const selectedValue = projectId ? selected?.id ?? null : "";

  return (
    <Select value={selectedValue} onValueChange={value => {
      if (value !== null) onChange(value || null);
    }}>
      <SelectTrigger size="sm" className="thread-project-select" aria-label={t("composer.choose_project")}
        title={label} disabled={locked || (!projectId && options.length === 0)}>
        <NavProjects size={ICON.sm} aria-hidden="true" />
        <span className="thread-project-select-name">{label}</span>
      </SelectTrigger>
      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="thread-project-content">
        <SelectItem value="">{noProject}</SelectItem>
        {options.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
