"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getWorkspaceBrief } from "../api";
import type { EmployeeAgent } from "../types";
import { agentLabel } from "../lib/plan";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { AgentMark } from "./AgentMark";
import { AgentPlacementBadge } from "./AgentPlacementBadge";
import { AgentProfilePanel } from "./AgentProfilePanel";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { IdentityMark } from "./IdentityMark";
import { PageHeader } from "./PageHeader";
import { ProfileImage } from "./ProfileImagePicker";
import { StatusPill } from "./StatusPill";
import { describeAgentPlacements } from "../lib/agentPlacements";
import { truncateId } from "../lib/adminHelpers";
import {
  ActivitiesSkeleton,
  WorkspaceActivities,
  WorkspaceError,
} from "./workspace/WorkspacePrimitives";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ICON } from "./icons";

export type AgentDetailTab = "profile" | "skills" | "activities";

const DETAIL_TABS: readonly AgentDetailTab[] = ["profile", "skills", "activities"];
const ACTIVITY_POLL_MS = 3000;

interface AgentDetailPageProps {
  agent: EmployeeAgent;
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
  const activityQuery = useQuery({
    queryKey: ["agent-activity-brief", agent.id],
    refetchInterval: pageTab === "activities" ? ACTIVITY_POLL_MS : false,
    queryFn: ({ signal }) => getWorkspaceBrief({ agentId: agent.id }, signal),
    enabled: pageTab === "activities",
  });
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
      value: <StatusPill value={agent.availability} />,
    },
    {
      key: "id",
      label: t("agents_page.agent_id"),
      value: truncateId(agent.id),
      technical: true,
      title: agent.id,
    },
  ];

  return (
    <Tabs
      render={<section id="agent-detail-panel" tabIndex={-1} />}
      className="workspace-page"
      aria-label={t("agents_page.detail_label", { name: agent.displayName })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as AgentDetailTab)}
    >
      <PageHeader
        kicker={t("nav.workforce")}
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
        titleVariant="record"
        titleAs="h2"
        layout="stacked"
        toolbar={(
          <TabsList className="workspace-page-tabs" aria-label={t("agents_page.detail_sections")}>
            {DETAIL_TABS.map((tab) => {
              const count = tab === "activities"
                ? brief ? brief.metrics.sessionCount || undefined : undefined
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

      <RecordBand facts={bandFacts} label={t("agents_page.record_label")} />

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
              emptyPulse
              onOpenThread={onOpenThread}
              agents={[agent]}
            />
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}
