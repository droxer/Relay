"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserAgent } from "../types";
import { agentLabel } from "../lib/plan";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { useWorkspaceActivity } from "../hooks/useWorkspaceActivity";
import { AgentMark } from "./AgentMark";
import { AgentPlacementBadge } from "./AgentPlacementBadge";
import { AgentProfilePanel } from "./AgentProfilePanel";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { IdentityMark } from "./IdentityMark";
import { PageHeader } from "./PageHeader";
import { ProfileImage } from "./ProfileImagePicker";
import { StatusPill, TonePill } from "./StatusPill";
import { describeAgentRosterStatus } from "../lib/agentStatus";
import { describeAgentPlacements } from "../lib/agentPlacements";
import { truncateId } from "../lib/adminHelpers";
import { agentModel } from "../lib/agentModels.ts";
import {
  ActivitiesSkeleton,
  WorkspaceActivities,
  WorkspaceError,
} from "./workspace/WorkspacePrimitives";
import type { RecordFact } from "./workspace/RecordBand";
import { RecordLayout } from "./workspace/RecordLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionApprove, ActionCopy, ICON } from "./icons";

export type AgentDetailTab = "profile" | "skills" | "activities";

const DETAIL_TABS: readonly AgentDetailTab[] = ["profile", "skills", "activities"];

interface AgentDetailPageProps {
  agent: UserAgent;
  onOpenThread: (sessionId: string) => void;
  canEditMeta?: boolean;
  onProfileDirtyChange?: (dirty: boolean) => void;
}

function parseDetailTab(value: string | null): AgentDetailTab {
  return DETAIL_TABS.includes(value as AgentDetailTab) ? value as AgentDetailTab : "profile";
}

export function AgentDetailPage({
  agent,
  onOpenThread,
  canEditMeta = false,
  onProfileDirtyChange,
}: AgentDetailPageProps) {
  const { t } = useTranslation();
  const [pageTab, setPageTab] = useUrlSearchState(
    "tab",
    "profile" as AgentDetailTab,
    parseDetailTab,
    (value) => value === "profile" ? null : value,
    "push",
  );
  const activityQuery = useWorkspaceActivity({ agentId: agent.id }, pageTab === "activities");
  const brief = activityQuery.data;
  const activitiesLoading = pageTab === "activities" && activityQuery.isLoading && !brief;
  const activitiesError = pageTab === "activities" && !brief && activityQuery.error
    ? activityQuery.error instanceof Error ? activityQuery.error.message : String(activityQuery.error)
    : "";

  const skillCount = (agent.skills ?? []).length;
  const placementDescriptions = describeAgentPlacements(agent.placements);
  const primaryPlacement = placementDescriptions.find(
    ({ placement }) => placement.desiredState === "active",
  ) ?? placementDescriptions[0];

  const [copiedId, setCopiedId] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);
  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(agent.id);
      setCopiedId(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(false), 1800);
    } catch {
      // Clipboard may be unavailable in insecure contexts.
    }
  }, [agent.id]);

  const model = agentModel(agent);
  const bandFacts: RecordFact[] = [
    {
      key: "runtime",
      label: t("admin.v2.agent_runtime"),
      value: (
        <span className="record-band-inline" translate="no">
          <AgentMark agent={agent.executorKind} size={ICON.sm} />
          {agentLabel(agent.executorKind)}
        </span>
      ),
    },
    {
      key: "model",
      label: t("agents_page.model_label"),
      value: model || (
        <span className="record-band-value--empty">{t("agents_page.model_default")}</span>
      ),
      technical: Boolean(model),
    },
    {
      key: "computer",
      label: t("agents_page.runtime_host"),
      value: primaryPlacement ? (
        <AgentPlacementBadge description={primaryPlacement} showSandbox />
      ) : (
        <span className="record-band-value--empty">{t("admin.v2.no_runtime_placement")}</span>
      ),
    },
    {
      key: "availability",
      label: t("admin.v2.agent_availability_label"),
      value: (() => {
        const rosterStatus = describeAgentRosterStatus(agent);
        if (!rosterStatus || rosterStatus.key.startsWith("status.")) {
          return <StatusPill value={agent.availability} />;
        }
        return (
          <TonePill
            tone={rosterStatus.tone === "live" ? "info" : rosterStatus.tone}
            label={t(rosterStatus.key)}
          />
        );
      })(),
    },
    {
      key: "id",
      label: t("agents_page.agent_id"),
      value: (
        <span className="record-band-id-row">
          <span className="record-band-id-text">{truncateId(agent.id, 6, 4)}</span>
          <button
            type="button"
            className="record-band-copy"
            data-copied={copiedId ? "true" : undefined}
            aria-label={copiedId ? t("admin.v2.copied") : t("admin.v2.copy")}
            title={copiedId ? t("admin.v2.copied") : t("admin.v2.copy")}
            onClick={() => void handleCopyId()}
          >
            {copiedId ? (
              <ActionApprove size={ICON.xs} aria-hidden="true" />
            ) : (
              <ActionCopy size={ICON.xs} aria-hidden="true" />
            )}
          </button>
        </span>
      ),
      technical: true,
      title: agent.id,
    },
  ];
  return (
    <Tabs
      render={<section id="agent-detail-panel" tabIndex={-1} />}
      className="workspace-page agent-detail-page"
      aria-label={t("agents_page.detail_label", { name: agent.displayName })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as AgentDetailTab)}
    >
      <PageHeader
        title={(
          <span className="workspace-header-title">
            <span className="workspace-header-mark" aria-hidden="true">
              <ProfileImage
                src={agent.profileImageUrl}
                alt=""
                fallback={<IdentityMark kind="agent" />}
              />
            </span>
            {agent.displayName}
          </span>
        )}
        topbarTitle={agent.displayName}
        titleVariant="record"
        titleAs="h1"
        layout="stacked"
        toolbar={(
          <TabsList className="workspace-page-tabs" stripKey={pageTab} aria-label={t("agents_page.detail_sections")}>
            {DETAIL_TABS.map((tab) => {
              const count = tab === "activities"
                ? brief?.sessions.length || undefined
                : tab === "skills" ? skillCount || undefined : undefined;
              return (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className={`workspace-page-tab${pageTab === tab ? " is-active" : ""}`}
                >
                  {t(`agents_page.tab_${tab}`)}
                  {count !== undefined ? <span className="workspace-page-tab-count tnum">{count}</span> : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        )}
      />

      <RecordLayout facts={bandFacts} label={t("agents_page.record_label")}>
        <div className="workspace-body">
          <TabsContent value="profile" className="workspace-profile">
            <AgentProfilePanel
              agent={agent}
              canEditMeta={canEditMeta}
              onDirtyChange={onProfileDirtyChange}
            />
          </TabsContent>
          <TabsContent value="skills" className="workspace-profile">
            <AgentSkillsPanel agent={agent} canEdit={canEditMeta} />
          </TabsContent>
          <TabsContent value="activities">
            {activitiesLoading ? (
              <ActivitiesSkeleton />
            ) : activitiesError ? (
              <WorkspaceError
                message={activitiesError}
                eyebrow={t("agents_page.activities_load_failed")}
                onRetry={() => void activityQuery.refetch()}
              />
            ) : (
              <WorkspaceActivities
                brief={brief}
                threadPagination={activityQuery}
                emptyPulse
                onOpenThread={onOpenThread}
                agents={[agent]}
              />
            )}
          </TabsContent>
        </div>
      </RecordLayout>
    </Tabs>
  );
}
