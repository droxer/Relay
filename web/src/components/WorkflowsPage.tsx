"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { deleteWorkflow, saveWorkflow } from "../api";
import { useInvalidateWorkflows, useStandaloneWorkflows, useWorkflowRecord } from "../hooks/useProjectWorkflows";
import { useUserAgents } from "../hooks/useUserAgents";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { computerId as stableComputerId, computerName as stableComputerName } from "../lib/createAgent";
import { nodesAssignedToUser } from "../lib/computerNodes";
import type { CurrentUser, DaemonNodeMonitorRecord, WorkflowPreview } from "../types";
import { ActionAdd, ICON, NavWorkflows } from "./icons";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { TonePill } from "./StatusPill";
import { ListSkeleton } from "./ListSkeleton";
import { ListRailResizeHandle } from "@/components/ListRailResize";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { SearchInput } from "@/components/ui/search-input";
import { WorkflowEditorForPreview } from "./workflow/WorkflowEditor";
import { WorkflowDetail } from "./workflow/WorkflowDetail";
import { workflowProcessMeta } from "./workflow/processMeta";

export function WorkflowsPage({
  currentUser,
  nodes,
  workflowId,
  onSelectWorkflow,
}: {
  currentUser: CurrentUser;
  nodes: DaemonNodeMonitorRecord[];
  workflowId: string | null;
  onSelectWorkflow: (workflowId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const invalidate = useInvalidateWorkflows();
  const { agents } = useUserAgents(currentUser.userId);
  const query = useStandaloneWorkflows();
  const workflows = useMemo(() => query.data?.workflows ?? [], [query.data]);
  const userComputers = useMemo(
    () => nodesAssignedToUser(nodes, currentUser.userId).filter((node) => !node.retiredAt),
    [nodes, currentUser.userId],
  );
  const computerLabels = useMemo(
    () => new Map(userComputers.map((node) => [stableComputerId(node), stableComputerName(node)])),
    [userComputers],
  );
  const [createOpen, setCreateOpen] = useUrlSearchState(
    "dialog",
    false,
    (value) => value === "create",
    (value) => (value ? "create" : null),
  );
  const [queryText, setQueryText] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null);
  const [editing, setEditing] = useState<WorkflowPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const sortedWorkflows = useMemo(
    () => [...workflows].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    [workflows],
  );

  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.displayName ?? t("backlog.assignment_unavailable_agent");
  const agentImage = (id: string) => agents.find((agent) => agent.id === id)?.profileImageUrl;
  const computerLabelFor = (id?: string | null) => (id ? computerLabels.get(id) ?? id : "");

  const visibleWorkflows = useMemo(() => {
    const normalized = queryText.trim().toLowerCase();
    if (!normalized) return sortedWorkflows;
    return sortedWorkflows.filter((workflow) => [
      workflow.name,
      computerLabelFor(workflow.computerId),
      ...workflow.workflowSteps.map((step) => step.name),
      ...workflow.workflowSteps.map((step) => agents.find((agent) => agent.id === step.agentId)?.displayName ?? ""),
    ].join(" ").toLowerCase().includes(normalized));
  }, [agents, computerLabels, queryText, sortedWorkflows]);

  const selectedWorkflow = useMemo(
    () => (workflowId ? sortedWorkflows.find((item) => item.id === workflowId) ?? null : null),
    [sortedWorkflows, workflowId],
  );
  const record = useWorkflowRecord(selectedWorkflow);
  const detail = record.data?.workflow;
  const selectedRowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedWorkflow?.id]);

  const toggleMutation = useMutation({
    mutationFn: (target: WorkflowPreview) => saveWorkflow({ enabled: !target.enabled }, target.id),
    onSuccess: (data) => {
      setActionError(null);
      return invalidate(data, detail ?? null);
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () => {
      setActionError(null);
      onSelectWorkflow(null);
      return invalidate();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const loading = query.isPending && workflows.length === 0;
  const busy = toggleMutation.isPending || deleteMutation.isPending;

  async function handleDelete(target: WorkflowPreview) {
    if (busy) return;
    const accepted = await confirm({
      title: t("teams.delete_title", { name: target.name }),
      message: t("workflows.delete_message"),
      confirmLabel: t("workflow.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await deleteMutation.mutateAsync(target.id);
  }

  return (
    <section
      id="workflows-panel"
      className="teams-page"
      data-view={selectedWorkflow ? "detail" : "list"}
      aria-label={t("workflows.title")}
      tabIndex={-1}
    >
      <div className="teams-roster">
        <PageHeader
          title={t("workflows.title")}
          count={t("workflows.count", { count: workflows.length })}
          titleAs="h2"
          titleVariant="title"
          layout="stacked"
          topbarActions={selectedWorkflow ? "inactive" : true}
          actions={(
            <Button
              variant="ghost"
              type="button"
              className="page-header-icon-action page-header-icon-action--primary"
              tooltip={t("workflow.create")}
              onClick={() => setCreateOpen(true)}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
            </Button>
          )}
        />

        <div className="list-filter-bar">
          <SearchInput
            className="list-filter-search"
            iconSize={ICON.sm}
            label={t("workflows.search_label")}
            name="workflows-query"
            value={queryText}
            placeholder={t("workflows.search_placeholder")}
            onChange={(event) => setQueryText(event.target.value)}
          />
        </div>

        <div className="teams-page-body">
          {loading ? (
            <ListSkeleton label={t("workflow.loading")} />
          ) : query.isError && workflows.length === 0 ? (
            <RelayEmptyState
              feature="workflows"
              title={t("workflow.load_failed")}
              body={query.error instanceof Error ? query.error.message : undefined}
              actions={<Button type="button" variant="outline" onClick={() => void query.refetch()}>{t("workspace.retry")}</Button>}
            />
          ) : visibleWorkflows.length === 0 ? (
            <RelayEmptyState
              feature="workflows"
              title={workflows.length === 0 ? t("workflows.empty_title") : t("workflows.empty_filtered_title")}
              body={workflows.length === 0 ? t("workflows.empty_body") : t("workflows.empty_filtered_body")}
              actions={workflows.length === 0 ? (
                <Button type="button" onClick={() => setCreateOpen(true)}>{t("workflow.create")}</Button>
              ) : undefined}
            />
          ) : (
            <ul className="teams-list" data-density="compact" aria-label={t("workflows.title")}>
              {visibleWorkflows.map((workflow) => {
                const selected = workflow.id === selectedWorkflow?.id;
                const computer = computerLabelFor(workflow.computerId);
                const summary = workflow.kind === "predefined"
                  ? t("workflow.predefined")
                  : workflowProcessMeta(t, workflow.workflowSteps);
                const meta = [computer, summary].filter(Boolean).join(" · ");
                return (
                  <li key={workflow.id} className="list-virtual" ref={selected ? selectedRowRef : undefined}>
                    <article className="teams-list-row rail-row" data-selected={selected ? "true" : "false"}>
                      <Button
                        variant="ghost"
                        type="button"
                        className="teams-list-row-select"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => {
                          setActionError(null);
                          onSelectWorkflow(workflow.id);
                        }}
                      >
                        <span className="teams-list-identity">
                          <span className="teams-list-titleline">
                            <span className="teams-list-title">{workflow.name}</span>
                          </span>
                          <span className="teams-list-sub">
                            <span className="teams-list-roster">{meta}</span>
                          </span>
                        </span>
                        <span className="teams-list-status">
                          {!workflow.enabled ? <TonePill tone="neutral" label={t("teams.disabled")} /> : null}
                          <span className="teams-list-mark" aria-hidden="true">
                            <NavWorkflows size={ICON.md} />
                          </span>
                        </span>
                      </Button>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <ListRailResizeHandle />
      </div>

      <div className="teams-detail">
        {selectedWorkflow ? (
          <WorkflowDetail
            workflow={selectedWorkflow}
            detail={detail}
            isPending={record.isPending}
            isError={record.isError}
            errorMessage={record.error instanceof Error ? record.error.message : undefined}
            onRetry={() => void record.refetch()}
            computerLabel={computerLabelFor(selectedWorkflow.computerId)}
            agentName={agentName}
            agentImage={agentImage}
            busy={busy}
            actionError={actionError}
            onBack={() => onSelectWorkflow(null)}
            onEdit={() => setEditing(selectedWorkflow)}
            onToggleEnabled={() => void toggleMutation.mutateAsync(selectedWorkflow)}
            onDelete={() => void handleDelete(selectedWorkflow)}
          />
        ) : (
          <RelayEmptyState
            feature="workflows"
            fill
            title={t("workflows.select_title")}
            body={t("workflows.select_body")}
          />
        )}
      </div>

      <WorkflowEditorForPreview
        open={createOpen || editing !== null}
        workflow={editing}
        computers={userComputers}
        teams={[]}
        agents={agents}
        onDeleted={() => onSelectWorkflow(null)}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
      />
    </section>
  );
}
