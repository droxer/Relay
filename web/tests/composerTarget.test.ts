import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { isTeamRoutable } from "../src/lib/taskAssignment.js";

const member = (availability: string, enabled = true) => ({
  id: `agt_${availability}`,
  displayName: availability,
  executorKind: "claude" as const,
  enabled,
  availability: availability as "ready" | "busy" | "pending" | "offline",
});

describe("composer team targeting", () => {
  it("routes a team only when every member can take work", () => {
    assert.equal(isTeamRoutable({ enabled: true, members: [member("ready"), member("busy")] }), true);
    assert.equal(isTeamRoutable({ enabled: true, members: [member("ready"), member("pending")] }), false);
    assert.equal(isTeamRoutable({ enabled: true, members: [member("ready"), member("offline")] }), false);
    assert.equal(isTeamRoutable({ enabled: false, members: [member("ready")] }), false);
    assert.equal(isTeamRoutable({ enabled: true, deletedAt: "2026-01-01", members: [member("ready")] }), false);
    assert.equal(isTeamRoutable({ enabled: true, members: [] }), false);
  });

  it("offers teams in the composer picker and keeps a started team thread locked", async () => {
    const select = await readFile(resolve("web/src/components/composer/AgentSelect.tsx"), "utf8");
    const app = await readFile(resolve("web/src/App.tsx"), "utf8");
    // The composer-send path moved into hooks/useThreadDispatch when App.tsx
    // was broken up; the assertion follows it rather than pinning the file it
    // used to live in.
    const dispatch = await readFile(resolve("web/src/hooks/useThreadDispatch.ts"), "utf8");

    assert.match(select, /teamSelectValue/);
    assert.match(select, /composer\.teams_group/);
    assert.match(select, /onTeamPicked/);
    // The trigger names the thread's target by identity, never through a
    // routability filter. Resolving the active agent with
    // `isEmployeeAgentRoutable` dropped the Select's value to null the moment
    // that agent went offline or was disabled, so the trigger announced "no
    // available agent" about an agent the thread was still pinned to — while
    // its option stayed listed below. Teams already resolved by id; agents
    // match. Routability still drives the affordance (disabled options and the
    // availability chip), which is why the import must remain in use.
    assert.match(
      select,
      /const activeLogicalAgent = logicalAgents\.find\(\(agent\) => agent\.id === activeLogicalAgentId\);/,
    );
    assert.doesNotMatch(select, /activeLogicalAgentId && isEmployeeAgentRoutable/);
    assert.match(select, /disabled=\{!isRoutable\}/);
    // A team thread keeps its roster for life, so the picker locks onto it.
    assert.match(app, /teamLocked=\{Boolean\(activeSession\?\.teamId\)\}/);
    // Team dispatch goes through teamId — the backend expands the roster.
    assert.match(dispatch, /teamId: pendingTeam\.id/);
  });
});

describe("composer agent selection", () => {
  it("names the same agents in `@` as in the footer picker", async () => {
    const app = await readFile(resolve("web/src/App.tsx"), "utf8");
    // The placement-derived list moved into useThreadTargets when App.tsx was
    // broken up; the assertion follows it rather than pinning the file it
    // used to live in. Both surfaces still read ONE effective list — ordinary
    // threads use placements, while project and team threads narrow that list
    // to their fixed roster — which is the property under test.
    const targets = await readFile(resolve("web/src/hooks/useThreadTargets.ts"), "utf8");
    assert.match(targets, /agentsForThreadNode\(logicalAgents,\s*selectedThreadNodeId\)/);
    assert.match(app, /mentionCandidates\(effectiveSelectableLogicalAgents\)/);
    assert.match(app, /effectiveSelectableLogicalAgents = useMemo/);
    // Both rosters narrow through the same seam, so neither surface can offer
    // a target its own round would refuse with `agent_forbidden`.
    assert.match(app, /activeProject[\s\S]{0,400}addressableThreadAgents/);
    assert.match(app, /activeTeam[\s\S]{0,400}addressableThreadAgents/);
  });

  it("gates the send shortcut on the same rule as the send button", async () => {
    const composer = await readFile(resolve("web/src/components/composer/Composer.tsx"), "utf8");
    // ⌘-Enter bypasses the button, so any condition that only disables the
    // button is not enforced at all. The two were written separately and had
    // drifted: the button refused a staged thread with no computer picked while
    // the shortcut dispatched it anyway, with nowhere to run. One derived value
    // now feeds both, which is the property under test — not its exact spelling.
    assert.match(composer, /const cannotSend =/);
    assert.match(composer, /initializingThread && !projectName && !runtimeNodeId/);
    assert.match(composer, /if \(cannotSend\) return;/);
    assert.match(composer, /disabled=\{!running && \(sendPending \|\| cannotSend\)\}/);
    // The guard must not be restated on the button alone.
    assert.equal(composer.match(/initializingThread && !projectName && !runtimeNodeId/g)?.length, 1);
  });

  it("dispatches a new thread to the agents the draft addresses", async () => {
    const dispatch = await readFile(resolve("web/src/hooks/useThreadDispatch.ts"), "utf8");
    assert.match(dispatch, /newThreadAgentIds = messageAddress\.addressAgentIds/);
    assert.match(dispatch, /assignments: newThreadAgentIds!\.map/);
  });

  it("addresses a continued direct thread to the footer's selected agent", async () => {
    const app = await readFile(resolve("web/src/hooks/useThreadDispatch.ts"), "utf8");
    assert.match(
      app,
      /resolveThreadMessageAddress\(\{[\s\S]*?defaultAgentId: projectRoomRound \|\| pendingTeam \|\| activeSession\?\.teamId[\s\S]*?: activeLogicalAgentId/,
    );
    assert.match(app, /addressAgentIds: messageAddress\.addressAgentIds/);
    assert.match(app, /projectId: activeProject\.id/);
  });

  it("includes the resolved responder in continued-thread retry identity", async () => {
    const app = await readFile(resolve("web/src/hooks/useThreadDispatch.ts"), "utf8");
    assert.match(
      app,
      /threadMessageOperationKey\(\{[\s\S]*?addressAgentIds: messageAddress\.addressAgentIds/,
    );
  });

  it("refuses a draft whose mention resolves to nobody, shortcut included", async () => {
    const composer = await readFile(
      resolve("web/src/components/composer/Composer.tsx"),
      "utf8",
    );
    // The disabled send button is not enough: Cmd+Enter calls triggerSend
    // directly, and a blocked draft sent that way addresses the whole room
    // instead of the agent the author named.
    assert.match(composer, /const triggerSend = \(\) => \{[\s\S]*?parsed\.blocked/);
  });

  it("shows the addressed agent in the footer while the draft names one", async () => {
    const composer = await readFile(
      resolve("web/src/components/composer/Composer.tsx"),
      "utf8",
    );
    assert.match(composer, /addressedLogicalAgentId \?\? activeLogicalAgentId/);
  });

  it("rewrites the draft's address run when the footer picks another agent", async () => {
    const composer = await readFile(
      resolve("web/src/components/composer/Composer.tsx"),
      "utf8",
    );
    // A leading mention outranks the picker at dispatch, so a pick that only
    // moved the footer would route to the agent the draft still names.
    assert.match(composer, /replaceAddressRun\(composerText, parsed\.mentions, agent\.displayName\)/);
    assert.match(composer, /onLogicalAgentPicked=\{pickLogicalAgent\}/);
    assert.match(composer, /onTeamPicked=\{pickTeam\}/);
  });

  it("offers a project thread its whole roster and each member", async () => {
    const select = await readFile(resolve("web/src/components/composer/AgentSelect.tsx"), "utf8");
    const composer = await readFile(resolve("web/src/components/composer/Composer.tsx"), "utf8");

    // The picker survives in a project room instead of being replaced by the
    // project chip: the roster is one option above its members.
    assert.match(select, /composer\.project_room/);
    assert.match(select, /composer\.project_members_group/);
    assert.match(select, /onRoomPicked/);
    assert.match(composer, /room=\{projectName \? projectRoom : null\}/);
    // A project room has no team of its own, so team options stay out of it.
    assert.match(composer, /teamOptionsEnabled=\{initializingThread && !projectName\}/);
  });

  it("narrows a project round to the picked member and widens it back", async () => {
    const app = await readFile(resolve("web/src/App.tsx"), "utf8");
    const composer = await readFile(resolve("web/src/components/composer/Composer.tsx"), "utf8");
    // The composer-send path moved into hooks/useThreadDispatch when App.tsx
    // was broken up; the assertion follows it rather than pinning the file it
    // used to live in.
    const dispatch = await readFile(resolve("web/src/hooks/useThreadDispatch.ts"), "utf8");

    // Room target means "no default agent", which the backend expands to the
    // whole roster; a picked member routes the round to them alone.
    assert.match(dispatch, /const projectRoomRound = Boolean\(activeProject\) && projectRoomTarget/);
    assert.match(app, /handleProjectRoomPicked[\s\S]*?setProjectRoomTarget\(true\)/);
    assert.match(app, /handleLogicalAgentPicked[\s\S]*?setProjectRoomTarget\(false\)/);
    // A new project thread carries the narrowed roster as assignments.
    assert.match(
      dispatch,
      /activeProject\s*\?\s*newThreadAgentIds!\.length\s*\?\s*\{ assignments: newThreadAgentIds!\.map/,
    );
    // A mention outranks the room pick, exactly as it outranks an agent pick.
    assert.match(composer, /const roomSelected = projectRoomSelected && !addressedLogicalAgentId/);
  });

  it("closes the `@` list once a name is accepted", async () => {
    const hook = await readFile(
      resolve("web/src/hooks/useMentionAutocomplete.ts"),
      "utf8",
    );
    // A completed name still parses as an open `@…` fragment; without this the
    // popup stays up listing the agent just picked.
    assert.match(hook, /acceptedText === text/);
    assert.match(hook, /setAcceptedText\(applied\.text\)/);
  });
});
