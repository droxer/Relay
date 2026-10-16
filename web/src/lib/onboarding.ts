import type {
  AgentName,
  CurrentUser,
  DaemonNodeMonitorRecord,
  OnboardingCard,
  RelaySession,
  UserAgent,
} from "../types.js";
import { agentsForThreadNode } from "./threadRuntime.ts";
import { dispatchReadyAgents } from "./agentReadiness.ts";
import { countUserDeviceComputers, nodesAssignedToUser } from "./computerNodes.ts";

/* The onboarding wizard's progress, derived from what exists rather than
   stored: a step is done because its Computer, Agent, or finished run is
   there. The account keeps only the person's own choices (`onboarding` on
   /auth/me — see backend/relay/security/onboarding.py). Design:
   docs/onboarding-wizard-design.md. */

export const ONBOARDING_CARDS: readonly OnboardingCard[] = ["tasks", "projects", "teams", "automations"];

/** What the client may ask the server to record. */
export type OnboardingPatch = {
  introSeen?: boolean;
  dismissed?: boolean;
  closedCards?: OnboardingCard[];
};

/** The three steps that build something; the intro and explore bracket them. */
export const SETUP_STEPS = ["computer", "agent", "thread"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];
export type OnboardingStep = "intro" | SetupStep | "explore";
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ["intro", ...SETUP_STEPS, "explore"];

export type OnboardingBlock = "computer_limit" | "no_ready_runtime";

export type OnboardingInputs = {
  user: Pick<CurrentUser, "userId" | "effectiveMaxLocalComputers" | "onboarding">;
  nodes: readonly DaemonNodeMonitorRecord[];
  agents: readonly Pick<UserAgent, "id" | "executorKind" | "placements" | "availability" | "enabled" | "deletedAt">[];
  /** The user's own threads. */
  threads: readonly Pick<RelaySession, "status" | "agentRuns">[];
};

export type OnboardingAgent = Pick<UserAgent, "id" | "executorKind">;
export type OnboardingTarget = { nodeId: string; agent: OnboardingAgent };

export type OnboardingComputer = { id: string; name: string; readyRuntimes: AgentName[] };

export type OnboardingProgress = {
  /** The first step not yet done. */
  step: OnboardingStep;
  done: Record<"intro" | SetupStep, boolean>;
  /** How many of the three setup steps are done. */
  completedCount: number;
  /** Why the computer step cannot finish on its own, when it cannot. */
  blocked?: OnboardingBlock;
  /** The computer the rest of the wizard works on, once one is online. */
  computer?: OnboardingComputer;
  agent?: OnboardingAgent;
  openCards: OnboardingCard[];
  visible: boolean;
};

function readyRuntimes(node: DaemonNodeMonitorRecord): AgentName[] {
  return dispatchReadyAgents(node, Object.keys(node.agents ?? {}) as AgentName[]);
}

function onlineComputer(nodes: readonly DaemonNodeMonitorRecord[]): OnboardingComputer | undefined {
  const online = nodes.filter((node) => node.online && !node.stale);
  // A computer that can run something beats one that is merely connected.
  const best = online.find((node) => readyRuntimes(node).length > 0) ?? online[0];
  return best
    ? { id: best.id, name: best.displayName || best.id, readyRuntimes: readyRuntimes(best) }
    : undefined;
}

function canEnrollComputer(
  user: OnboardingInputs["user"],
  mine: readonly DaemonNodeMonitorRecord[],
): boolean {
  const limit = user.effectiveMaxLocalComputers;
  return limit === undefined || countUserDeviceComputers(mine) < limit;
}

function hasFinishedRun(thread: Pick<RelaySession, "status" | "agentRuns">): boolean {
  return (thread.agentRuns ?? []).some((run) => run.status === "completed");
}

export function onboardingProgress({ user, nodes, agents, threads }: OnboardingInputs): OnboardingProgress {
  const prefs = user.onboarding ?? {};
  const mine = nodesAssignedToUser([...nodes], user.userId);
  const available = agents.filter((agent) => !agent.deletedAt && agent.enabled
    && (agent.availability === "ready" || agent.availability === "busy"));
  // Keep the Computer and Agent together: the first online Computer may have
  // no Agent, while a later one is already able to take the guided first run.
  const agentNode = mine.find((node) => node.online && !node.stale
    && agentsForThreadNode(available, node.id).some((agent) => readyRuntimes(node).includes(agent.executorKind)));
  const computer = onlineComputer(agentNode ? [agentNode] : mine);
  const readyAgent = computer && agentsForThreadNode(available, computer.id)
    .find((agent) => computer.readyRuntimes.includes(agent.executorKind));
  const agent = readyAgent ? { id: readyAgent.id, executorKind: readyAgent.executorKind } : undefined;
  const done = {
    intro: Boolean(prefs.introSeenAt),
    computer: Boolean(computer && computer.readyRuntimes.length > 0),
    agent: Boolean(agent),
    thread: threads.some(hasFinishedRun),
  };
  const blocked: OnboardingBlock | undefined = done.computer
    ? undefined
    : computer
      ? "no_ready_runtime"
      : canEnrollComputer(user, mine) ? undefined : "computer_limit";
  const step = (["intro", ...SETUP_STEPS] as const).find((name) => !done[name]) ?? "explore";
  const closed = new Set(prefs.closedCards ?? []);
  const openCards = ONBOARDING_CARDS.filter((card) => !closed.has(card));
  const completedCount = SETUP_STEPS.filter((name) => done[name]).length;
  // An account that finished setting up before the wizard existed never read
  // its intro; greeting it with "Explore next" would be noise.
  const setUpWithoutWizard = completedCount === SETUP_STEPS.length && !done.intro;
  const visible = !prefs.dismissedAt
    && !setUpWithoutWizard
    && !(step === "explore" && openCards.length === 0);
  return { step, done, completedCount, blocked, computer, agent, openCards, visible };
}
