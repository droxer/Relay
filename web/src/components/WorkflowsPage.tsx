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
import { ActionAdd, ActionEdit, ActionToggle, AdminDelete, ICON, NavBack, NavWorkflows } from "./icons";
import { MobileTopbarBack } from "./MobileTopbarSlot";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { TonePill } from "./StatusPill";
import { ListSkeleton } from "./ListSkeleton";
import { ListRailResizeHandle } from "@/components/ListRailResize";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { SearchInput } from "@/components/ui/search-input";
import { WorkflowEditorForPreview } from "./workflow/WorkflowEditor";
import { WorkflowStepSummary } from "./workflow/WorkflowStepSummary";
import { workflowProcessMeta } from "./workflow/processMeta";
import { WorkflowAgentFace } from "./workflow/WorkflowAgentFace";
import { PredefinedWorkflowIcon } from "./workflow/PredefinedWorkflowIcon";

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
          <>
            <MobileTopbarBack
              label={t("workflows.title")}
              onBack={() => onSelectWorkflow(null)}
              fallback={(
                <Button
                  type="button"
                  variant="ghost"
                  className="teams-mobile-back"
                  onClick={() => onSelectWorkflow(null)}
                >
                  <NavBack size={ICON.sm} aria-hidden="true" />
                  {t("workflows.title")}
                </Button>
              )}
            />
            <div className="workspace-page">
              <PageHeader
                title={selectedWorkflow.name}
                subtitle={[
                  computerLabelFor(selectedWorkflow.computerId),
                  selectedWorkflow.kind === "predefined"
                    ? t("workflow.predefined")
                    : workflowProcessMeta(t, selectedWorkflow.workflowSteps),
                ].filter(Boolean).join(" · ")}
                titleAs="h2"
                titleVariant="title"
                actions={(
                  <div className="workflow-team-actions">
                    {!selectedWorkflow.enabled ? <TonePill tone="neutral" label={t("teams.disabled")} /> : null}
                    {selectedWorkflow.kind !== "predefined" ? (
                      <Button type="button" variant="outline" size="dense" disabled={busy} onClick={() => setEditing(selectedWorkflow)}>
                        <ActionEdit size={ICON.sm} aria-hidden="true" />
                        {t("workflow.edit_steps")}
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" size="dense" disabled={busy} onClick={() => void toggleMutation.mutateAsync(selectedWorkflow)}>
                      <ActionToggle size={ICON.sm} aria-hidden="true" />
                      {t(selectedWorkflow.enabled ? "workflows.disable" : "workflows.enable")}
                    </Button>
                    <Button type="button" variant="ghost" size="dense" disabled={busy} onClick={() => void handleDelete(selectedWorkflow)}>
                      <AdminDelete size={ICON.sm} aria-hidden="true" />
                      {t("workflow.delete")}
                    </Button>
                  </div>
                )}
              />

              <div className="workspace-page-body">
                {actionError ? <p role="alert" className="text-destructive">{actionError}</p> : null}

                {selectedWorkflow.workflowSteps.length > 0 ? (
                  <section className="project-general-section" aria-label={t("workflow.steps")}>
                    <WorkflowStepSummary
                      steps={selectedWorkflow.workflowSteps}
                      label={t("workflow.steps_of", { name: selectedWorkflow.name })}
                      agentName={agentName}
                      agentImage={agentImage}
                    />
                  </section>
                ) : null}

                {record.isPending ? (
                  <ListSkeleton label={t("workflow.loading")} />
                ) : record.isError ? (
                  <RelayEmptyState
                    feature="workflows"
                    title={t("workflow.load_failed")}
                    body={record.error instanceof Error ? record.error.message : undefined}
                    actions={<Button type="button" variant="outline" onClick={() => void record.refetch()}>{t("workspace.retry")}</Button>}
                  />
                ) : detail?.kind === "predefined" && detail.predefined ? (
                  <section className="workflow-step-card" aria-label={t("workflow.predefined")}>
                    <div className="workflow-team-row-name">
                      <PredefinedWorkflowIcon style={detail.predefined.template} />
                      <h3 className="workflow-library-name">{t(`collab_style.${detail.predefined.template}`)}</h3>
                      {detail.predefined.humanApproval ? <span className="workflow-step-gate">{t("workflow.gate_badge")}</span> : null}
                    </div>
                    <p className="workflow-library-meta">{t(`collab_style.${detail.predefined.template}_hint`)}</p>
                    <div className="workflow-preset-participants">
                      <ul aria-label={t("workflow.preset_participants")}>
                        {detail.predefined.memberAgentIds.map((memberId) => (
                          <li key={memberId}>
                            <WorkflowAgentFace imageUrl={agentImage(memberId)} />
                            <span>{agentName(memberId)}</span>
                            {memberId === detail.predefined?.leadAgentId ? (
                              <span className="workflow-library-meta">{t("collab_style.turn_lead")}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {detail.predefined.acceptanceCriteria?.length ? (
                      <ul className="list-disc pl-5 text-sm text-muted-foreground">
                        {detail.predefined.acceptanceCriteria.map((criterion, idx) => <li key={idx}>{criterion}</li>)}
                      </ul>
                    ) : null}
                  </section>
                ) : detail ? (
                  <ol className="workflow-step-list" aria-label={t("workflow.steps")}>
                    {detail.workflowSteps.map((step, index) => (
                      <li key={step.id} className="workflow-step-card">
                        <div className="workflow-project-row-head">
                          <div className="workflow-library-main">
                            <div className="workflow-team-row-name">
                              <span className="workflow-flow-index tnum" aria-hidden="true">{index + 1}</span>
                              <h3 className="workflow-library-name">{step.name}</h3>
                              {step.requiresApproval ? <span className="workflow-step-gate">{t("workflow.gate_badge")}</span> : null}
                            </div>
                            <p className="workflow-library-meta flex items-center gap-2">
                              <WorkflowAgentFace imageUrl={agentImage(step.agentId)} />
                              <span>{agentName(step.agentId)}</span>
                            </p>
                          </div>
                        </div>
                        <p className="workflow-library-meta whitespace-pre-wrap">{step.instructions}</p>
                        {step.acceptanceCriteria.length > 0 ? (
                          <ul className="list-disc pl-5 text-sm text-muted-foreground">
                            {step.acceptanceCriteria.map((criterion, idx) => <li key={idx}>{criterion}</li>)}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </div>
          </>
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
