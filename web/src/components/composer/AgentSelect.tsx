import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StateMark } from "../StateMark";
import { availabilityPipTone } from "./availabilityTone";
import type { AgentTeam, EmployeeAgent } from "../../types";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { isEmployeeAgentRoutable, visualAvailabilityOf } from "../../lib/agentDisplayNames";
import { isTeamRoutable, teamAvailability } from "../../lib/taskAssignment";
import { RosterAgentItem, RosterOption, RosterTeamItem, RosterTriggerValue } from "../roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "../roster/RosterTabs";

const TEAM_VALUE_PREFIX = "team:";
const ROOM_VALUE = "room:all";

export function teamSelectValue(teamId: string): string {
  return `${TEAM_VALUE_PREFIX}${teamId}`;
}

export function parseTeamSelectValue(value: string | null): string | null {
  return value?.startsWith(TEAM_VALUE_PREFIX) ? value.slice(TEAM_VALUE_PREFIX.length) : null;
}


/** The project roster as one identity. It draws the same `.agent-state` box a
 *  team does — one mark size across every row and trigger in the picker —
 *  with its tone carrying whether the room can take a round at all. */
function RoomMark({ routable, label }: { routable: boolean; label: string }) {
  return (
    <span
      className={`agent-state ${routable ? "tone-good" : "tone-bad"}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <ProfileImage src={null} alt="" fallback={<IdentityMark kind="team" />} />
    </span>
  );
}

// Target picker above the composer: selects who the thread talks to —
// one logical (employee) agent, a whole agent team, or — in a project room —
// the project's whole roster. Non-routable entries stay listed (disabled) with
// their availability spelled out so users can see why a target cannot take the
// thread. A started thread may hand its next round to any agent or team on
// its computer, so the picker stays live for the thread's whole life.
export function AgentSelect({ logicalAgents, activeLogicalAgentId, onLogicalAgentPicked, teams = [], activeTeamId = null, onTeamPicked, teamOptionsEnabled = false, room = null, roomSelected = false, onRoomPicked, running = false }: {
  logicalAgents: EmployeeAgent[];
  activeLogicalAgentId: string | null;
  onLogicalAgentPicked: (agent: EmployeeAgent) => void;
  /** Full live-team list: resolves the active team chip even when picking is
   *  disabled, so a started team thread still names its team. */
  teams?: AgentTeam[];
  activeTeamId?: string | null;
  onTeamPicked?: (team: AgentTeam) => void;
  /** Teams are pickable everywhere but a project room, whose targets are the
   *  room and its own members. The caller passes only teams whose whole
   *  roster lives on the thread's computer. */
  teamOptionsEnabled?: boolean;
  /** The project room's whole roster, offered as one target above its members.
   *  Absent outside a project thread. */
  room?: { memberCount: number } | null;
  roomSelected?: boolean;
  onRoomPicked?: () => void;
  /** True while THIS thread's run is the cause of the selected agent being
   *  busy — suppresses the trigger busy pip, which would otherwise duplicate
   *  the rail's live pulse 20px away. */
  running?: boolean;
}) {
  const { t } = useTranslation();
  // Identity, not routability. A thread's agent is whoever it is even after
  // they go busy, offline, or disabled mid-thread — and those are exactly the
  // moments the trigger has to keep naming them, the same way the computer
  // readout keeps naming a machine that went offline. Filtering this lookup by
  // `isEmployeeAgentRoutable` dropped the selection instead: the Select's
  // `value` fell to null while the option stayed listed below, so the trigger
  // announced "no available agent" about an agent the thread was still pinned
  // to, and picking that agent again was a no-op because it was already the
  // value. Routability drives the affordance — the disabled option and the
  // availability chip — never who is named. `activeTeam` already resolves this
  // way; agents now match.
  const activeLogicalAgent = logicalAgents.find((agent) => agent.id === activeLogicalAgentId);
  const activeTeam = teams.find((team) => team.id === activeTeamId && !team.deletedAt) ?? null;
  // The roster is the target only while no single member is picked, so the
  // trigger never claims the whole room while a mention narrows the round.
  const activeRoom = room && roomSelected && !activeTeam ? room : null;
  // A round the whole roster cannot take is still worth offering: the project
  // reports why at dispatch. One member able to work is enough to keep it live.
  const roomRoutable = logicalAgents.some(isEmployeeAgentRoutable);
  const handleSelected = (value: string | null) => {
    if (value === ROOM_VALUE) {
      onRoomPicked?.();
      return;
    }
    const teamId = parseTeamSelectValue(value);
    if (teamId) {
      const team = teams.find((candidate) => candidate.id === teamId);
      if (team && isTeamRoutable(team)) onTeamPicked?.(team);
      return;
    }
    const next = logicalAgents.find((agent) => agent.id === value);
    if (next && isEmployeeAgentRoutable(next)) onLogicalAgentPicked(next);
  };
  // Agents and agent teams are two rosters, so the popup tabs between them
  // rather than stacking both into one scroll — the same picker the task
  // drawer uses. A project thread offers teams nowhere (its targets are the
  // room and its own members), so there it is one roster and the strip does
  // not render.
  const teamsOffered = teamOptionsEnabled && teams.length > 0;
  const tabs: RosterTab<"agents" | "teams">[] = teamsOffered
    ? [
        { id: "agents", label: t("composer.agents_group"), count: logicalAgents.length },
        { id: "teams", label: t("composer.teams_group"), count: teams.length },
      ]
    : [{ id: "agents", label: t("composer.agents_group"), count: logicalAgents.length }];
  const roster = useRosterTabs({
    tabs,
    activeTab: activeTeam ? "teams" : "agents",
    label: t("thread.talk_to_agent_or_team"),
  });

  return (
    <Select
      value={activeRoom ? ROOM_VALUE : activeTeam ? teamSelectValue(activeTeam.id) : (activeLogicalAgent?.id ?? null)}
      onValueChange={handleSelected}
      onOpenChange={(open) => {
        if (open) roster.resetTab();
      }}
    >
      <SelectTrigger
        size="sm"
        className="chat-agent-select"
        disabled={logicalAgents.length === 0 && (!teamOptionsEnabled || teams.length === 0)}
        data-availability={activeRoom
          ? (roomRoutable ? "ready" : "offline")
          : activeTeam
          ? teamAvailability(activeTeam)
          : activeLogicalAgent
          ? visualAvailabilityOf(activeLogicalAgent)
          : "unavailable"}
        aria-label={room
          ? t("thread.talk_to_project")
          : teamOptionsEnabled && teams.length > 0
          ? t("thread.talk_to_agent_or_team")
          : t("thread.talk_to_agent")}
      >
        {activeRoom ? (
          // The room is an identity like any other target, so it wears the
          // roster trigger — same mark box, same name type — and only its
          // words differ. Its name carries `--room` because the generic team
          // glyph identifies nothing on its own: agents and teams may drop to
          // a mark on a phone, the room may not.
          <span className="roster-trigger">
            <RoomMark routable={roomRoutable} label={t("composer.project_room")} />
            <span className="roster-trigger-name roster-trigger-name--room">
              {t("composer.project_room")}
            </span>
          </span>
        ) : activeTeam ? (
          <RosterTriggerValue team={activeTeam} />
        ) : activeLogicalAgent ? (
          <RosterTriggerValue agent={activeLogicalAgent} hideBusyPulse={running} />
        ) : (
          <span className="chat-agent-select-unavailable">
            <StateMark tone="bad" />
            <span className="chat-agent-select-unavailable-text">{t("thread.no_available_agent")}</span>
          </span>
        )}
      </SelectTrigger>
      <SelectContent
        className="chat-agent-select-content"
        align="start"
        alignItemWithTrigger={false}
        side="top"
        onKeyDownCapture={roster.onKeyDownCapture}
        header={roster.header}
      >
        {roster.header ? (
          // Tabbed: the strip names the roster, so the group labels it replaced
          // are gone and only the active roster is listed.
          <SelectGroup aria-label={rosterLabel(tabs, roster.tab)}>
            {roster.tab === "teams"
              ? teams.map((team) => teamOption({ team, t }))
              : agentOptions({ logicalAgents, t })}
          </SelectGroup>
        ) : room ? (
          // A project thread's targets are one roster — the room and the
          // members inside it — so they stay stacked under their own labels.
          <>
            <SelectGroup>
              <SelectLabel>{t("composer.project_group")}</SelectLabel>
              <SelectItem
                value={ROOM_VALUE}
                label={t("composer.project_room")}
                className="chat-agent-option"
                disabled={!roomRoutable}
                data-availability={roomRoutable ? "ready" : "offline"}
              >
                {/* A team row's shape exactly: mark, name, roster size under
                    it. The count used to be pushed to the right edge in the
                    availability slot, which is where every other row states
                    why it cannot take work. */}
                <span className="roster-option">
                  <RoomMark routable={roomRoutable} label={t("composer.project_room")} />
                  <span className="roster-option-copy">
                    <span>{t("composer.project_room")}</span>
                    <span>{t("teams.member_count", { count: room.memberCount })}</span>
                  </span>
                </span>
              </SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>{t("composer.project_members_group")}</SelectLabel>
              {agentOptions({ logicalAgents, t })}
            </SelectGroup>
          </>
        ) : (
          agentOptions({ logicalAgents, t })
        )}
      </SelectContent>
    </Select>
  );
}

// The task drawers and chat use the same identity rows. Only chat disables
// unavailable targets — and spells out why, so users can see why a target
// cannot take the thread: tasks can be assigned now and run when they are
// ready.
function teamOption({ team, t }: {
  team: AgentTeam;
  t: TFunction;
}) {
  const isRoutable = isTeamRoutable(team);
  const availability = teamAvailability(team);
  return (
    <RosterTeamItem
      key={team.id}
      value={teamSelectValue(team.id)}
      team={team}
      className="chat-agent-option"
      disabled={!isRoutable}
      data-availability={availability}
    >
      <RosterOption team={team} />
      {!isRoutable ? (
        <span className="chat-agent-option-availability" data-availability={availability}>
          <StateMark tone={availabilityPipTone(availability)} />
          {t(`status.${availability}`, { defaultValue: availability })}
        </span>
      ) : null}
    </RosterTeamItem>
  );
}

function agentOptions({ logicalAgents, t }: {
  logicalAgents: EmployeeAgent[];
  t: TFunction;
}) {
  return logicalAgents.map((logicalAgent) => {
    const isRoutable = isEmployeeAgentRoutable(logicalAgent);
    const visualAvailability = visualAvailabilityOf(logicalAgent);
    return (
      <RosterAgentItem
        key={logicalAgent.id}
        value={logicalAgent.id}
        agent={logicalAgent}
        className="chat-agent-option"
        disabled={!isRoutable}
        data-availability={visualAvailability}
      >
        <RosterOption agent={logicalAgent} />
        {!isRoutable ? (
          <span className="chat-agent-option-availability" data-availability={visualAvailability}>
            <StateMark tone={availabilityPipTone(visualAvailability)} />
            {t(`status.${visualAvailability}`, { defaultValue: visualAvailability })}
          </span>
        ) : null}
      </RosterAgentItem>
    );
  });
}
