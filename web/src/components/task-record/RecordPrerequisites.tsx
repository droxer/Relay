"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/Pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { listPrerequisiteChoices } from "../../api-client/tasks";
import { TASKS_QUERY_KEY } from "../../hooks/useRelayData";
import { pathForAppState } from "../../lib/appRoute";
import { DEFAULT_PAGE_SIZE, describePage, paginate } from "../../lib/pagination";
import { PREREQUISITES_MAX, prerequisiteCandidates } from "../../lib/taskPrerequisites";
import { taskRef } from "../../lib/taskRef";
import type { RelayTaskListItem } from "../../types";
import { TaskRefLink } from "../task-board/TaskRefLink";

function PrerequisitePicker({ task, projectId, onSelect }: {
  task: RelayTaskListItem;
  projectId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const search = useDebouncedValue(query.trim(), 250);
  const awaitingSearch = search !== query.trim();
  const searchInput = useRef<HTMLInputElement>(null);
  const choices = useQuery({
    queryKey: [...TASKS_QUERY_KEY, projectId, "prerequisite-choices", task.id, search, page],
    queryFn: ({ signal }) => listPrerequisiteChoices(projectId, task.id, search, page, signal),
    enabled: open && !awaitingSearch,
    staleTime: 30_000,
  });
  const result = choices.data;
  const visible = result?.page ? describePage(result.tasks, result.page, DEFAULT_PAGE_SIZE)
    : paginate(result?.tasks.filter(item => item.id !== task.id && !task.unblocks?.includes(item.id)
      && !task.prerequisiteTaskIds?.includes(item.id)
      && `${taskRef(item)} ${item.title}`.toLowerCase().includes(search.toLowerCase())) ?? [], page);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="record-prerequisite-add" />}>
      {t("prerequisites.add")}
    </PopoverTrigger>
    <PopoverContent align="start" initialFocus={searchInput}>
      <Input ref={searchInput} type="search" value={query} aria-label={t("backlog.search")} placeholder={t("backlog.search")}
        onChange={(event) => { setQuery(event.currentTarget.value); setPage(1); }} />
      {awaitingSearch || choices.isPending ? <p role="status">{t("issues.loading")}</p> : choices.isError ? (
        <div role="alert">
          <p>{t("issues.load_failed")}</p>
          <Button type="button" variant="ghost" onClick={() => void choices.refetch()}>{t("project.retry")}</Button>
        </div>
      ) : visible.items.length ? (
        <>
          <ul className="max-h-72 overflow-y-auto">
            {visible.items.map(item => <li key={item.id}>
              <Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left"
                onClick={() => { setOpen(false); onSelect(item.id); }}>
                {taskRef(item)} {item.title}
              </Button>
            </li>)}
          </ul>
          <Pagination compact page={visible} onPageChange={setPage} label={t("prerequisites.title")} />
        </>
      ) : <p role="status">{t("backlog.no_match_title")}</p>}
    </PopoverContent>
  </Popover>;
}

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
  loadChoices = false,
}: {
  task: RelayTaskListItem;
  /** Every task the viewer has loaded; the project's are the candidates. */
  tasks: readonly RelayTaskListItem[];
  readOnly: boolean;
  onOpenTask: (taskId: string) => void;
  loadChoices?: boolean;
}) {
  const { t } = useTranslation();
  const { setTaskPrerequisitesMutation } = useRelayMutations();
  if (!task.projectId || task.isRoutine) return null;
  const byId = new Map([...tasks, ...(task.prerequisiteSummaries ?? [])].map((item) => [item.id, item] as const));
  const current = task.prerequisiteTaskIds ?? [];
  const waiting = new Set(task.waitingOn ?? []);
  const unblocks = task.unblocks ?? [];
  const chosen = new Set(current);
  const candidates = loadChoices ? [] : prerequisiteCandidates(task, tasks).filter((item) => !chosen.has(item.id));
  const editable = !readOnly && !setTaskPrerequisitesMutation.isPending;
  const canAdd = editable && (loadChoices || candidates.length > 0) && current.length < PREREQUISITES_MAX;
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
            {canAdd && loadChoices ? (
              <PrerequisitePicker key={task.id} task={task} projectId={task.projectId} onSelect={id => save([...current, id])} />
            ) : canAdd ? (
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
