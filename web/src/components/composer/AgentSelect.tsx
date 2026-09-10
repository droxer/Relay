import { useTranslation } from "react-i18next";
import { StateMark, type StateTone } from "../StateMark";
import type { AgentTeam, EmployeeAgent } from "../../types";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { isEmployeeAgentRoutable, visualAvailabilityOf } from "../../lib/agentDisplayNames";
import { isTeamRoutable, teamAvailability } from "../../lib/taskAssignment";

const TEAM_VALUE_PREFIX = "team:";
const ROOM_VALUE = "room:all";

export function teamSelectValue(teamId: string): string {
  return `${TEAM_VALUE_PREFIX}${teamId}`;
}

export function parseTeamSelectValue(value: string | null): string | null {
  return value?.startsWith(TEAM_VALUE_PREFIX) ? value.slice(TEAM_VALUE_PREFIX.length) : null;
}

/**
 * Availability → pip tone. `ready` and `busy` both stay neutral here: this
 * pip always sits beside the availability word, so hue only has to separate
 * the states the label cannot make urgent on its own. `offline`/`inactive`
 * resolve to `bad`, which StateMark draws as the hollow ring.
 */
const PIP_TONE: Record<string, StateTone> = {
  pending: "warn",
  offline: "bad",
  inactive: "bad",
};
const pipTone = (availability: string): StateTone => PIP_TONE[availability] ?? "neutral";

// Target picker for the composer footer: selects who the thread talks to —
// one logical (employee) agent, a whole agent team, or — in a project room —
// the project's whole roster. Non-routable entries stay listed (disabled) with
// their availability spelled out so users can see why a target cannot take the
// thread. A team thread keeps the team fixed for
// its lifetime, so `teamLocked` renders the trigger read-only.
export function AgentSelect({ logicalAgents, activeLogicalAgentId, onLogicalAgentPicked, teams = [], activeTeamId = null, onTeamPicked, teamLocked = false, teamOptionsEnabled = false, room = null, roomSelected = false, onRoomPicked, running = false }: {
  logicalAgents: EmployeeAgent[];
  activeLogicalAgentId: string | null;
  onLogicalAgentPicked: (agent: EmployeeAgent) => void;
  /** Full live-team list: resolves the active team chip even when picking is
   *  disabled, so a started team thread still names its team. */
  teams?: AgentTeam[];
  activeTeamId?: string | null;
  onTeamPicked?: (team: AgentTeam) => void;
  teamLocked?: boolean;
  /** Teams are pickable only while staging a new thread — a started thread
   *  keeps the participants it began with. */
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
  return (
    <Select value={activeRoom ? ROOM_VALUE : activeTeam ? teamSelectValue(activeTeam.id) : (activeLogicalAgent?.id ?? null)} onValueChange={handleSelected}>
      <SelectTrigger
        size="sm"
        className="chat-agent-select"
        disabled={teamLocked || (logicalAgents.length === 0 && (!teamOptionsEnabled || teams.length === 0))}
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
          <>
            <ProfileImage
              src={null}
              alt=""
              fallback={<IdentityMark kind="team" />}
              className="chat-active-agent-mark"
            />
            <span className="chat-agent-select-name">{t("composer.project_room")}</span>
          </>
        ) : activeTeam ? (
          <>
            <ProfileImage
              src={activeTeam.profileImageUrl}
              alt=""
              fallback={<IdentityMark kind="team" />}
              className="chat-active-agent-mark"
            />
            <span className="chat-agent-select-name" translate="no">
              {activeTeam.name}
            </span>
          </>
        ) : activeLogicalAgent ? (
          <>
            <ProfileImage
              src={activeLogicalAgent.profileImageUrl}
              alt=""
              fallback={<IdentityMark kind="agent" />}
              className="chat-active-agent-mark"
            />
            <span className="chat-agent-select-name" translate="no">
              {activeLogicalAgent.displayName}
            </span>
          </>
        ) : (
          <span className="chat-agent-select-unavailable">
            <StateMark tone="bad" />
            {t("thread.no_available_agent")}
          </span>
        )}
        {!activeRoom && !activeTeam && !running && activeLogicalAgent?.availability === "busy" ? (
          <>
            <span className="header-agent-busy-pip" aria-hidden="true" />
            <span className="sr-only">{t("status.busy")}</span>
          </>
        ) : null}
      </SelectTrigger>
      <SelectContent className="chat-agent-select-content" align="start" alignItemWithTrigger={false} side="top">
        {room ? (
          <SelectGroup>
            <SelectLabel>{t("composer.project_group")}</SelectLabel>
            <SelectItem
              value={ROOM_VALUE}
              className="chat-agent-option"
              disabled={!roomRoutable}
              data-availability={roomRoutable ? "ready" : "offline"}
            >
              <ProfileImage
                src={null}
                alt=""
                fallback={<IdentityMark kind="team" />}
                className="chat-agent-option-mark"
              />
              <span>{t("composer.project_room")}</span>
              <span className="chat-agent-option-availability">
                {t("teams.member_count", { count: room.memberCount })}
              </span>
            </SelectItem>
          </SelectGroup>
        ) : null}
        {teamOptionsEnabled && teams.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{t("composer.teams_group")}</SelectLabel>
            {teams.map((team) => {
              const isRoutable = isTeamRoutable(team);
              const availability = teamAvailability(team);
              const availabilityLabel = !isRoutable
                ? t(`status.${availability}`, { defaultValue: availability })
                : null;
              return (
                <SelectItem
                  key={team.id}
                  value={teamSelectValue(team.id)}
                  className="chat-agent-option"
                  disabled={!isRoutable}
                  data-availability={availability}
                >
                  <ProfileImage
                    src={team.profileImageUrl}
                    alt=""
                    fallback={<IdentityMark kind="team" />}
                    className="chat-agent-option-mark"
                  />
                  <span translate="no">{team.name}</span>
                  <span className="chat-agent-option-availability">
                    {t("teams.member_count", { count: team.members.length })}
                  </span>
                  {availabilityLabel ? (
                    <span className="chat-agent-option-availability" data-availability={availability}>
                      <StateMark tone={pipTone(availability)} />
                      {availabilityLabel}
                    </span>
                  ) : null}
                </SelectItem>
              );
            })}
          </SelectGroup>
        ) : null}
        {room || (teamOptionsEnabled && teams.length > 0) ? (
          <SelectGroup>
            <SelectLabel>{room ? t("composer.project_members_group") : t("composer.agents_group")}</SelectLabel>
            {agentOptions({ logicalAgents, t })}
          </SelectGroup>
        ) : (
          agentOptions({ logicalAgents, t })
        )}
      </SelectContent>
    </Select>
  );
}

function agentOptions({ logicalAgents, t }: {
  logicalAgents: EmployeeAgent[];
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return logicalAgents.map((logicalAgent) => {
    const isRoutable = isEmployeeAgentRoutable(logicalAgent);
    const isBusy = logicalAgent.availability === "busy";
    const visualAvailability = visualAvailabilityOf(logicalAgent);
    const availabilityLabel = !isRoutable
      ? t(`status.${visualAvailability}`, {
          defaultValue: visualAvailability,
        })
      : null;
    return (
      <SelectItem
        key={logicalAgent.id}
        value={logicalAgent.id}
        className="chat-agent-option"
        disabled={!isRoutable}
        data-availability={visualAvailability}
      >
        <ProfileImage
          src={logicalAgent.profileImageUrl}
          alt=""
          fallback={<IdentityMark kind="agent" />}
          className="chat-agent-option-mark"
        />
        <span translate="no">{logicalAgent.displayName}</span>
        {availabilityLabel ? (
          <span className="chat-agent-option-availability" data-availability={visualAvailability}>
            <StateMark tone={pipTone(visualAvailability)} />
            {availabilityLabel}
          </span>
        ) : null}
        {isBusy ? (
          <>
            <span className="header-agent-busy-pip" aria-hidden="true" />
            <span className="sr-only">{t("status.busy")}</span>
          </>
        ) : null}
      </SelectItem>
    );
  });
}
