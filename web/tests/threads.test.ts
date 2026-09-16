import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  canDeleteThread,
  matchesThreadQuery,
  myThreadSessions,
  pickActiveThreadSession,
  sessionAgents,
  threadLabel,
  threadOriginIndex,
  threadRowMeta,
  upsertThreadSession,
} from "../src/lib/threads.js";
import {
  agentsForThreadNode,
  assignableThreadComputers,
  threadNeedsRuntimeSelection,
  resolveNewThreadComputer,
  selectableThreadComputers,
  threadComputerSignature,
  threadRuntimeNodeId,
} from "../src/lib/threadRuntime.js";
import { isAwaitingFeedbackDecision, rerunAssignmentForSession } from "../src/lib/workflow.js";
import type { RelaySession } from "../src/types.js";

type AgentRuns = RelaySession["agentRuns"];
const runs = (...agents: string[]): AgentRuns => agents.map((agent) => ({ agent }) as AgentRuns[number]);

function session(partial: Partial<RelaySession>): RelaySession {
  return {
    id: "ses_x",
    workspacePath: "/workspace",
    taskGoal: "do a thing",
    participants: ["human"],
    status: "running",
    phase: "created",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    agentRuns: [],
    artifacts: [],
    decisions: [],
    events: [],
    ...partial,
  } as RelaySession;
}

describe("sessionAgents", () => {
  it("returns distinct agents in first-appearance order, deduped across runs", () => {
    assert.deepEqual(
      sessionAgents(session({ agentRuns: runs("codex", "claude", "claude"), currentAgent: undefined })),
      ["codex", "claude"],
    );
  });

  it("includes the current agent even without a recorded run", () => {
    assert.deepEqual(
      sessionAgents(session({ agentRuns: runs("pi"), currentAgent: "kimi" })),
      ["pi", "kimi"],
    );
  });

  it("is empty for a fresh session with no runs", () => {
    assert.deepEqual(sessionAgents(session({ agentRuns: runs(), currentAgent: undefined })), []);
  });
});

describe("web thread helpers", () => {
  it("blocks deletion while the session or daemon still has a run in flight", () => {
    assert.equal(canDeleteThread({ session: session({ status: "running" }) }), true);
    assert.equal(
      canDeleteThread({
        session: session({ status: "cancelled" }),
        runningAgent: "claude",
      }),
      true,
    );
    assert.equal(canDeleteThread({ session: session({ status: "cancelled" }) }), true);
  });

  it("selects a computer first and exposes only agents placed on it", () => {
    const nodes = [
      { id: "node_a", employeeId: "alice", online: true, stale: false, status: "ready" },
      { id: "node_b", employeeId: "alice", online: true, stale: false, status: "running" },
      { id: "node_bob", employeeId: "bob", online: true, stale: false, status: "ready" },
      { id: "node_stale", employeeId: "alice", online: true, stale: true, status: "ready" },
    ];
    const agents = [
      { id: "agent_a", placements: [{ daemonNodeId: "node_a", desiredState: "active" }] },
      { id: "agent_b", placements: [{ daemonNodeId: "node_b", desiredState: "active" }] },
      { id: "agent_replaced", placements: [{ daemonNodeId: "node_old", runtimeNodeId: "node_a", desiredState: "active" }] },
      { id: "agent_removed", placements: [{ daemonNodeId: "node_a", desiredState: "removed" }] },
    ];

    assert.deepEqual(
      selectableThreadComputers(nodes, "alice").map((node) => node.id),
      ["node_a", "node_b"],
    );
    assert.deepEqual(
      agentsForThreadNode(agents, "node_a").map((agent) => agent.id),
      ["agent_a", "agent_replaced"],
    );
    assert.equal(threadRuntimeNodeId(session({ daemonNodeId: "node_a" })), "node_a");
    assert.equal(
      threadRuntimeNodeId(
        session({
          daemonNodeId: "node_old",
          managedNodeId: "computer_a",
        }),
        agents,
        [
          {
            id: "node_new",
            managedNodeId: "computer_a",
            employeeId: "alice",
            online: true,
            stale: false,
            status: "ready",
          },
        ],
      ),
      "node_new",
    );
    assert.equal(
      threadRuntimeNodeId(
        session({
          daemonNodeId: "node_old",
          agentRuns: [{
            id: "run_a",
            agent: "codex",
            logicalAgentId: "agent_a",
            status: "completed",
            startedAt: "2026-06-20T00:00:00.000Z",
            artifactIds: [],
          } as AgentRuns[number]],
        }),
        agents,
        [{
          id: "node_a",
          managedNodeId: "computer_a",
          employeeId: "alice",
          online: true,
          stale: false,
          status: "ready",
        }],
      ),
      "node_a",
    );
    assert.equal(threadNeedsRuntimeSelection(session({ daemonNodeId: "node_a" }), false), false);
    assert.equal(threadNeedsRuntimeSelection(session({}), false), true);
    assert.equal(threadNeedsRuntimeSelection(session({ daemonNodeId: "node_a" }), true), true);
    assert.equal(
      threadRuntimeNodeId(session({
        agentRuns: [{
          id: "run_b",
          agent: "codex",
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          artifactIds: [],
          daemonNodeId: "node_b",
        } as AgentRuns[number]],
      })),
      "node_b",
    );
  });

  it("infers the pinned computer from the running agent's placement on legacy threads", () => {
    const agents = [
      { id: "agent_a", placements: [{ daemonNodeId: "node_a", desiredState: "active" }] },
      { id: "agent_b", placements: [{ daemonNodeId: "node_b", desiredState: "active" }] },
      { id: "agent_gone", placements: [{ daemonNodeId: "node_c", desiredState: "removed" }] },
    ];
    const legacyRun = (logicalAgentId: string) => ({
      id: `run_${logicalAgentId}`,
      agent: "claude",
      logicalAgentId,
      status: "completed",
      startedAt: "2026-06-20T00:00:00.000Z",
      artifactIds: [],
    } as AgentRuns[number]);

    // Latest run with a resolvable placement wins.
    assert.equal(
      threadRuntimeNodeId(session({ agentRuns: [legacyRun("agent_a"), legacyRun("agent_b")] }), agents),
      "node_b",
    );
    // Removed placements don't count; fall through to an earlier run.
    assert.equal(
      threadRuntimeNodeId(session({ agentRuns: [legacyRun("agent_a"), legacyRun("agent_gone")] }), agents),
      "node_a",
    );
    // A stamped session or run still wins over the inference.
    assert.equal(
      threadRuntimeNodeId(session({ daemonNodeId: "node_z", agentRuns: [legacyRun("agent_a")] }), agents),
      "node_z",
    );
    // No agents resolved: the thread still needs a selection.
    assert.equal(threadRuntimeNodeId(session({ agentRuns: [legacyRun("agent_a")] })), undefined);
    assert.equal(
      threadNeedsRuntimeSelection(session({ agentRuns: [legacyRun("agent_a")] }), false, agents),
      false,
    );
  });

  it("lists only the employee's own non-archived sessions, newest first", () => {
    const sessions = [
      session({ id: "a", ownerEmployeeId: "alice", updatedAt: "2026-06-20T01:00:00.000Z" }),
      session({ id: "b", ownerEmployeeId: "bob", updatedAt: "2026-06-20T05:00:00.000Z" }),
      session({ id: "c", ownerEmployeeId: "alice", archived: true, updatedAt: "2026-06-20T09:00:00.000Z" }),
      session({ id: "d", ownerEmployeeId: "alice", updatedAt: "2026-06-20T03:00:00.000Z" }),
    ];
    const mine = myThreadSessions(sessions, "alice");
    assert.deepEqual(mine.map((s) => s.id), ["d", "a"]);
  });

  it("keeps ownerless legacy sessions for the current employee", () => {
    const sessions = [session({ id: "legacy", ownerEmployeeId: undefined })];
    assert.deepEqual(myThreadSessions(sessions, "alice").map((s) => s.id), ["legacy"]);
  });

  it("labels by title when set, falling back to the task goal", () => {
    assert.equal(threadLabel(session({ title: "Auth bug", taskGoal: "fix auth" })), "Auth bug");
    assert.equal(threadLabel(session({ title: "   ", taskGoal: "fix auth" })), "fix auth");
    assert.equal(threadLabel(session({ taskGoal: "fix auth" })), "fix auth");
  });

  it("matches the search query against title and task goal", () => {
    const s = session({ title: "Auth bug", taskGoal: "fix the redirect" });
    assert.equal(matchesThreadQuery(s, ""), true);
    assert.equal(matchesThreadQuery(s, "auth"), true);
    assert.equal(matchesThreadQuery(s, "redirect"), true);
    assert.equal(matchesThreadQuery(s, "deploy"), false);
  });

  it("picks the selected active thread only from visible threads", () => {
    const visible = session({ id: "visible", ownerEmployeeId: "alice", updatedAt: "2026-06-20T03:00:00.000Z" });
    const selected = session({ id: "selected", ownerEmployeeId: "alice", updatedAt: "2026-06-20T01:00:00.000Z" });

    assert.equal(pickActiveThreadSession({
      threads: [visible, selected],
      selectedSessionId: "selected",
      activeSessionId: "visible",
      composingNew: false,
    })?.id, "selected");
  });

  it("falls back when the selected thread is stale, archived, or out of scope", () => {
    const sessions = [
      session({ id: "archived", ownerEmployeeId: "alice", archived: true, updatedAt: "2026-06-20T09:00:00.000Z" }),
      session({ id: "bob", ownerEmployeeId: "bob", updatedAt: "2026-06-20T08:00:00.000Z" }),
      session({ id: "active", ownerEmployeeId: "alice", updatedAt: "2026-06-20T03:00:00.000Z" }),
    ];
    const threads = myThreadSessions(sessions, "alice");

    assert.deepEqual(threads.map((item) => item.id), ["active"]);
    assert.equal(pickActiveThreadSession({
      threads,
      selectedSessionId: "archived",
      activeSessionId: null,
      composingNew: false,
    })?.id, "active");
  });

  it("suppresses all active thread fallback while composing a new thread", () => {
    const threads = [session({ id: "active", ownerEmployeeId: "alice" })];

    assert.equal(pickActiveThreadSession({
      threads,
      selectedSessionId: "active",
      activeSessionId: "active",
      composingNew: true,
    }), undefined);
  });

  // Creating a thread returns the new session before the list refetch
  // lands. Without seeding it into the cached list the selection points at an
  // id nobody can find, so the fallback lands on threads[0] — the
  // previous thread — and the transcript flashes it before jumping.
  it("opens the freshly created thread instead of the previous thread", () => {
    const previous = session({ id: "previous", ownerEmployeeId: "alice", updatedAt: "2026-06-20T03:00:00.000Z" });
    const created = session({ id: "created", ownerEmployeeId: "alice", updatedAt: "2026-06-20T04:00:00.000Z" });

    const threads = upsertThreadSession([previous], created);
    assert.equal(pickActiveThreadSession({
      threads,
      selectedSessionId: created.id,
      activeSessionId: created.id,
      composingNew: false,
    })?.id, "created");
  });

  it("shows recovery decisions only for explicit feedback waits", () => {
    assert.equal(isAwaitingFeedbackDecision(session({
      status: "waiting_for_human",
      pendingDecision: "feedback",
    })), true);
    assert.equal(isAwaitingFeedbackDecision(session({
      status: "running",
      pendingDecision: undefined,
    })), false);
    assert.equal(isAwaitingFeedbackDecision(session({
      status: "completed",
      pendingDecision: undefined,
    })), false);
  });

  it("reruns the latest session agent", () => {
    const assignment = rerunAssignmentForSession(session({
      currentAgent: "claude",
      agentRuns: [{
        id: "run_1",
        agent: "codex",
        role: "reviewer",
        status: "failed",
        startedAt: "2026-06-20T00:00:00.000Z",
        artifactIds: [],
      }],
    }), "claude");
    assert.deepEqual(assignment, { agent: "codex" });
  });
});

describe("new-thread computer selection", () => {
  const ready = (id: string, over: Record<string, unknown> = {}) => ({
    id, employeeId: "alice", online: true, stale: false, status: "ready", ...over,
  });

  it("keeps the picked computer when a poll reports it briefly unselectable", () => {
    const picked = ready("node_b");
    const fleet = [ready("node_a"), { ...picked, stale: true }];
    const assignable = assignableThreadComputers(fleet, "alice");
    const selectable = selectableThreadComputers(fleet, "alice");

    assert.deepEqual(selectable.map((node) => node.id), ["node_a"]);
    assert.equal(resolveNewThreadComputer("node_b", selectable, assignable), "node_b");
  });

  it("falls back to the first selectable computer only once the pick is gone", () => {
    const fleet = [ready("node_a"), ready("node_c")];
    const assignable = assignableThreadComputers(fleet, "alice");
    const selectable = selectableThreadComputers(fleet, "alice");

    assert.equal(resolveNewThreadComputer("node_b", selectable, assignable), "node_a");
    assert.equal(resolveNewThreadComputer(null, selectable, assignable), "node_a");
    assert.equal(resolveNewThreadComputer("node_b", [], []), null);
  });

  it("drops a pick that belongs to another employee", () => {
    // The fleet spans employees for an admin actor, so switching who you are
    // acting as must not leave the previous employee's machine picked.
    const fleet = [ready("node_a"), ready("bobs_node", { employeeId: "bob" })];
    const assignable = assignableThreadComputers(fleet, "alice");
    const selectable = selectableThreadComputers(fleet, "alice");

    assert.deepEqual(assignable.map((node) => node.id), ["node_a"]);
    assert.equal(resolveNewThreadComputer("bobs_node", selectable, assignable), "node_a");
  });

  it("drops a pick whose computer has been deleted or retired", () => {
    const fleet = [
      ready("node_a"),
      ready("tombstone", { status: "deleted", online: false }),
      ready("retired", { retiredAt: "2026-07-26T10:00:00Z" }),
    ];
    const assignable = assignableThreadComputers(fleet, "alice");
    const selectable = selectableThreadComputers(fleet, "alice");

    assert.deepEqual(assignable.map((node) => node.id), ["node_a"]);
    assert.equal(resolveNewThreadComputer("tombstone", selectable, assignable), "node_a");
    assert.equal(resolveNewThreadComputer("retired", selectable, assignable), "node_a");
  });

  it("ignores heartbeat churn when keying the computer list", () => {
    const first = [ready("node_a", { lastSeenAt: "2026-07-26T10:00:00Z", lastSeenAgeMs: 900 })];
    const second = [ready("node_a", { lastSeenAt: "2026-07-26T10:00:03Z", lastSeenAgeMs: 120 })];

    assert.equal(threadComputerSignature(first), threadComputerSignature(second));
    assert.notEqual(
      threadComputerSignature(first),
      threadComputerSignature([ready("node_a"), ready("node_b")]),
    );
  });

  it("re-keys when a computer's ownership resolves", () => {
    // The rows and the trigger draw their mark from nodeLocation, so a node
    // that stops being pending has to re-render even though the list is
    // otherwise identical.
    const pending = [ready("node_a")];
    const located = [ready("node_a", { nodeLocation: "employee-device" })];

    assert.notEqual(threadComputerSignature(pending), threadComputerSignature(located));
  });
});

describe("adaptive composer contract", () => {
  it("does not expose execution modes in the composer or handoff controls", () => {
    const composer = readFileSync("web/src/components/composer/Composer.tsx", "utf8");
    const handoff = readFileSync("web/src/components/composer/DecisionBar.tsx", "utf8");

    assert.doesNotMatch(composer, /ModeToggle|composerMode|setComposerMode/);
    assert.doesNotMatch(handoff, /handoffMode|setHandoffMode|modeOptions/);
  });
});

/* A full thread row's second line exists to carry status. A settled thread
   deliberately says nothing about status (the group header above it already
   reads "idle"), which left the line holding only the decorative agent
   cluster — 16px of row height for one ornamental glyph, on the majority of
   rows in a long list. */
describe("threadRowMeta", () => {
  it("keeps the second line for a row that has status to speak", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "full", hasStatus: true, hasOrigin: false, agentCount: 2 }),
      { subline: true, inlineAgents: false },
    );
  });

  it("drops the second line and inlines the marks for a settled row", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "full", hasStatus: false, hasOrigin: false, agentCount: 2 }),
      { subline: false, inlineAgents: true },
    );
  });

  // Nothing to inline, nothing to line-break for: the row is its title.
  it("collapses a settled row that no agent has touched", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "full", hasStatus: false, hasOrigin: false, agentCount: 0 }),
      { subline: false, inlineAgents: false },
    );
  });

  /* A backlog or routine thread names its source in words on the meta line,
     so a settled task thread keeps its second line even with no status. */
  it("keeps the second line for a settled row that names its origin", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "full", hasStatus: false, hasOrigin: true, agentCount: 2 }),
      { subline: true, inlineAgents: true },
    );
  });

  /* The origin's name is the meta segment a narrow rail must not crush, so
     the decorative agent marks move up to the title line whenever it shows. */
  it("inlines the agent marks when status and origin share the meta line", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "full", hasStatus: true, hasOrigin: true, agentCount: 1 }),
      { subline: true, inlineAgents: true },
    );
  });

  /* Nested rows are single-line by construction — they carry their own state
     pip because the flat in-project list has no group headers, and adding
     marks would undo the density that layout exists for. */
  it("leaves nested rows single-line whatever their state", () => {
    assert.deepEqual(
      threadRowMeta({ layout: "nested", hasStatus: true, hasOrigin: true, agentCount: 3 }),
      { subline: false, inlineAgents: false },
    );
    assert.deepEqual(
      threadRowMeta({ layout: "nested", hasStatus: false, hasOrigin: false, agentCount: 3 }),
      { subline: false, inlineAgents: false },
    );
  });
});

/* A thread started by a backlog task or a routine run says so on its row.
   Only the task side records the link (linkedSessionIds), so the rail inverts
   it once per task-list change rather than scanning tasks per row. */
describe("threadOriginIndex", () => {
  type OriginTask = Parameters<typeof threadOriginIndex>[0][number];
  const task = (partial: Partial<OriginTask> & { id: string }): OriginTask => ({
    title: partial.id,
    isRoutine: false,
    linkedSessionIds: [],
    ...partial,
  });

  it("marks a backlog task's threads with the task title", () => {
    const index = threadOriginIndex([task({ id: "t1", title: "Fix login", linkedSessionIds: ["s1", "s2"] })]);
    assert.deepEqual(index.get("s1"), { kind: "backlog", taskId: "t1", title: "Fix login" });
    assert.deepEqual(index.get("s2"), { kind: "backlog", taskId: "t1", title: "Fix login" });
  });

  it("names a routine occurrence's thread after its parent routine", () => {
    const index = threadOriginIndex([
      task({ id: "r1", title: "Weekly KPIs", isRoutine: true }),
      task({ id: "occ1", title: "Weekly KPIs · 2026-09-14", sourceRoutineId: "r1", linkedSessionIds: ["s1"] }),
    ]);
    assert.deepEqual(index.get("s1"), { kind: "routine", taskId: "occ1", title: "Weekly KPIs" });
  });

  it("falls back to the occurrence title when the parent routine is not listed", () => {
    const index = threadOriginIndex([
      task({ id: "occ1", title: "Standup notes", sourceRoutineId: "gone", linkedSessionIds: ["s1"] }),
    ]);
    assert.deepEqual(index.get("s1"), { kind: "routine", taskId: "occ1", title: "Standup notes" });
  });

  it("treats a thread linked to the routine itself as a routine thread", () => {
    const index = threadOriginIndex([task({ id: "r1", title: "Daily digest", isRoutine: true, linkedSessionIds: ["s1"] })]);
    assert.equal(index.get("s1")?.kind, "routine");
  });

  it("ignores deleted tasks and leaves plain chats unmarked", () => {
    const index = threadOriginIndex([
      task({ id: "t1", linkedSessionIds: ["s1"], deletedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    assert.equal(index.get("s1"), undefined);
    assert.equal(index.get("chat"), undefined);
  });
});
