"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useTeams } from "../hooks/useTeams";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { selectedTeamForWorkspace } from "../lib/teamWorkspace";
import { teamAvailability } from "../lib/taskAssignment";
import { StatusPill, TonePill } from "./StatusPill";
import type { CurrentUser } from "../types";
import {
  ActionAdd,
  ICON,
  NavBack,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { TeamDrawer } from "./admin/TeamDrawer";
import { TeamWorkspacePage } from "./TeamWorkspacePage";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";

export function TeamsPage({
  currentUser,
  onOpenThread,
  teamId,
  onSelectTeam,
}: {
  currentUser: CurrentUser;
  onOpenThread: (sessionId: string) => void;
  teamId: string | null;
  onSelectTeam: (teamId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { teams, isFetching, error, refetch } = useTeams(currentUser.employeeId);
  const [addTeam, setAddTeam] = useUrlSearchState(
    "dialog",
    false,
    (value) => value === "create",
    (value) => value ? "create" : null,
  );
  const [query, setQuery] = useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null);
  const sortedTeams = useMemo(
    () => [...teams].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    [teams],
  );
  // Same search contract as the agent roster and the thread rail: a name
  // match, plus the roster line the row already prints, so what you can read
  // on a row is what you can search for.
  const visibleTeams = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedTeams;
    return sortedTeams.filter((team) => [
      team.name,
      ...team.members.map((member) => member.displayName),
    ].join(" ").toLowerCase().includes(normalized));
  }, [query, sortedTeams]);
  const loading = isFetching && teams.length === 0;
  const selectedTeam = selectedTeamForWorkspace(sortedTeams, teamId);
  const selectedRowRef = useRef<HTMLLIElement>(null);

  /* The roster is a bounded scroll region (46vh once it stacks above the
     detail). Deep-linking to a team otherwise lands with its row clipped to a
     sliver at the bottom edge. */
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedTeam?.id]);

  return (
    <section
      id="teams-panel"
      className="teams-page"
      data-view={selectedTeam ? "detail" : "list"}
      aria-label={t("teams.title")}
      tabIndex={-1}
    >
      <div className="teams-roster">
        <PageHeader
          kicker={t("nav.workforce")}
          title={t("teams.title")}
          count={t("teams.count", { count: teams.length })}
          titleVariant="display"
          layout="stacked"
          actions={(
            // The shared list-header create affordance — a ghost plus, same
            // as the projects/threads rail.
            <Button
              variant="ghost"
              type="button"
              className="page-header-icon-action"
              tooltip={t("teams.add")}
              onClick={() => setAddTeam(true)}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
            </Button>
          )}
        />

        {/* The shared filter band every list rail carries (inputs.css), so a
            roster is searched the same way wherever you are. */}
        <div className="list-filter-bar">
          <SearchInput
            className="list-filter-search"
            iconSize={ICON.sm}
            label={t("teams.search_label")}
            name="teams-query"
            value={query}
            placeholder={t("teams.search_placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="teams-page-body">
          {loading ? (
            <div className="route-loading" role="status" aria-live="polite">{t("admin.loading")}</div>
          ) : error && teams.length === 0 ? (
            <RelayEmptyState
              title={t("workspace.load_failed")}
              body={error}
              actions={<Button type="button" variant="outline" onClick={() => void refetch()}>{t("workspace.retry")}</Button>}
            />
          ) : visibleTeams.length === 0 ? (
            <RelayEmptyState
              title={teams.length === 0 ? t("teams.empty_title") : t("teams.empty_filtered_title")}
              body={teams.length === 0 ? t("teams.empty_body") : t("teams.empty_filtered_body")}
            />
          ) : (
            /* A roster rail, not a table: no column header, and rows are
               inset rounded objects separated by a 2px gutter — the same
               list language as .agents-roster-list and .conversation-rows.
               The two facts a row carried under column headers (name, status)
               read positionally here, as they do on every other rail. */
            /* Compact density: a roster rail is a list layout, so names sit
               one rung down (16 → 15px) against their 13px meta — scoped to
               the list, as on the agent roster, so the detail pane beside it
               keeps its record density. */
            <ul className="teams-list" data-density="compact" aria-label={t("teams.title")}>
              {visibleTeams.map((team) => {
                // Lead first, then the rest of the crew. Listing every member
                // after the lead printed the lead's name twice on every row.
                const supportNames = team.members
                  .filter((member) => member.id !== team.leadAgentId)
                  .map((member) => member.displayName)
                  .join(", ");
                const roster = team.lead?.displayName
                  ? [team.lead.displayName, supportNames].filter(Boolean).join(" · ")
                  : supportNames || t("teams.no_members");
                const selected = team.id === selectedTeam?.id;
                return (
                  <li
                    key={team.id}
                    className="list-virtual"
                    ref={selected ? selectedRowRef : undefined}
                  >
                    <article className="teams-list-row rail-row" data-selected={selected ? "true" : "false"}>
                      <Button
                        variant="ghost"
                        type="button"
                        className="teams-list-row-select"
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onSelectTeam(team.id)}
                      >
                        <span className="teams-list-mark" aria-hidden="true">
                          <ProfileImage
                            src={team.profileImageUrl}
                            alt=""
                            fallback={<IdentityMark kind="team" />}
                          />
                        </span>
                        <span className="teams-list-identity">
                          <span className="teams-list-title">{team.name}</span>
                          <small className="teams-list-sub">{roster}</small>
                        </span>
                        <span className="teams-list-status">
                          {/* "ready" is the default healthy state and stays
                              implicit; other roster states get named. */}
                          {!team.enabled ? (
                            <TonePill tone="neutral" label={t("teams.disabled")} />
                          ) : teamAvailability(team) !== "ready" ? (
                            <StatusPill value={teamAvailability(team)} />
                          ) : null}
                        </span>
                      </Button>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="teams-detail">
        {selectedTeam ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="teams-mobile-back"
              onClick={() => onSelectTeam(null)}
            >
              <NavBack size={ICON.sm} aria-hidden="true" />
              {t("teams.title")}
            </Button>
            <TeamWorkspacePage
              key={selectedTeam.id}
              team={selectedTeam}
              employeeId={currentUser.employeeId}
              onOpenThread={onOpenThread}
              onDeleted={() => onSelectTeam(null)}
            />
          </>
        ) : (
          <RelayEmptyState fill title={t("teams.select_title")} body={t("teams.select_body")} />
        )}
      </div>

      <TeamDrawer
        open={addTeam}
        employeeId={currentUser.employeeId}
        onClose={() => setAddTeam(false)}
      />
    </section>
  );
}
