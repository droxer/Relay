"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { pathForAppState } from "../../lib/appRoute";
import { PREREQUISITES_MAX, prerequisiteCandidates } from "../../lib/taskPrerequisites";
import { taskRef } from "../../lib/taskRef";
import type { RelayTaskListItem } from "../../types";
import { TaskRefLink } from "../task-board/TaskRefLink";

/**
 * What a project task waits for and what waits for it.
 *
 * "Depends on" is the one relation a person sets here; the scheduler holds a
 * ready task until every task it names is done. "Unblocks" is its mirror,
 * derived by the backend, so it is read-only. A task outside a project has
 * neither: prerequisites stay within one project.
 */
export function RecordPrerequisites({
  task,
  tasks,
  readOnly,
  onOpenTask,
}: {
  task: RelayTaskListItem;
  /** Every task the viewer has loaded; the project's are the candidates. */
  tasks: readonly RelayTaskListItem[];
  readOnly: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const { setTaskPrerequisitesMutation } = useRelayMutations();
  if (!task.projectId || task.isRoutine) return null;
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const current = task.prerequisiteTaskIds ?? [];
  const waiting = new Set(task.waitingOn ?? []);
  const unblocks = task.unblocks ?? [];
  const chosen = new Set(current);
  const candidates = prerequisiteCandidates(task, tasks).filter((item) => !chosen.has(item.id));
  const editable = !readOnly && !setTaskPrerequisitesMutation.isPending;
  const canAdd = editable && candidates.length > 0 && current.length < PREREQUISITES_MAX;
  const save = (ids: string[]) => setTaskPrerequisitesMutation.mutate({ taskId: task.id, prerequisiteTaskIds: ids });
  const refText = (id: string) => {
    const item = byId.get(id);
    return item ? taskRef(item) : id;
  };

  const link = (id: string) => {
    const item = byId.get(id);
    if (!item) return <span translate="no">{id}</span>;
    const href = pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId: id });
    return (
      <>
        <TaskRefLink task={item} href={href} onOpen={() => onOpenTask(id)} />
        <span className="record-prerequisite-title">{item.title}</span>
      </>
    );
  };

  return (
    <section className="record-definition-facts" aria-labelledby="record-prerequisites">
      <h3 id="record-prerequisites" className="record-section-title">{t("prerequisites.title")}</h3>
      <dl className="record-facts">
        <div className="record-facts-row">
          <dt>{t("prerequisites.depends_on")}</dt>
          <dd>
            {current.length ? (
              <ul className="record-prerequisites">
                {current.map((id) => (
                  <li key={id} className="record-prerequisite">
                    {link(id)}
                    <span className="record-prerequisite-state">
                      {t(waiting.has(id) ? "prerequisites.open" : "prerequisites.done")}
                    </span>
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="dense"
                        aria-label={t("prerequisites.remove", { ref: refText(id) })}
                        onClick={() => save(current.filter((item) => item !== id))}
                      >
                        {t("prerequisites.remove_short")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : <span className="record-empty">{t("prerequisites.none")}</span>}
            {canAdd ? (
              <Select
                value={null}
                onValueChange={(value) => { if (typeof value === "string") save([...current, value]); }}
              >
                <SelectTrigger className="record-prerequisite-add" aria-label={t("prerequisites.add")}>
                  <SelectValue placeholder={t("prerequisites.add")} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{`${taskRef(item)} ${item.title}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </dd>
        </div>
        <div className="record-facts-row">
          <dt>{t("prerequisites.unblocks")}</dt>
          <dd>
            {unblocks.length ? (
              <ul className="record-prerequisites">
                {unblocks.map((id) => <li key={id} className="record-prerequisite">{link(id)}</li>)}
              </ul>
            ) : <span className="record-empty">{t("prerequisites.none")}</span>}
          </dd>
        </div>
      </dl>
    </section>
  );
}
