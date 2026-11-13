import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, createRef } from "react";
import { expect, it, vi } from "vitest";
import { Composer } from "../src/components/composer/Composer";
import type { MentionCandidate } from "../src/lib/mentions";
import type { UserAgent } from "../src/types";

/* The live `@` wiring, end to end: the real Composer, the real
   `useMentionAutocomplete`, the real `lib/mentions` parsing. `mentionPopup.test.tsx`
   injects `matches` and so proves only the presentation half — every bug this
   file pins lived in the half it could not see. */

const CANDIDATES: MentionCandidate[] = [
  { id: "a1", displayName: "Ada", eligible: true },
  { id: "a2", displayName: "Alan", eligible: true },
];

const AGENTS = [
  { id: "a1", displayName: "Ada", executorKind: "claude", availability: "ready", placements: [], enabled: true },
  { id: "a2", displayName: "Alan", executorKind: "claude", availability: "ready", placements: [], enabled: true },
] as unknown as UserAgent[];

function setup(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  render(
    <Composer
      ref={createRef()}
      logicalAgents={AGENTS}
      activeLogicalAgentId="a1"
      onLogicalAgentPicked={vi.fn()}
      activeAgentDisplayName="Ada"
      selectedUser="emp"
      initializingThread={false}
      runtimeNodes={[]}
      runtimeNodeId="n1"
      selectedRuntimeNode={null}
      activeRuntimeNode={null}
      onRuntimeNodeChange={vi.fn()}
      running={false}
      mentionCandidates={CANDIDATES}
      onSend={vi.fn()}
      onCancelRun={vi.fn()}
      {...overrides}
    />,
  );
  return { field: screen.getByRole("textbox") as HTMLTextAreaElement };
}

it.each([
  { text: "Continue", expected: { addressAgentIds: ["a1"] } },
  { text: "@Alan Continue", expected: { addressAgentIds: ["a2"] } },
])("queues the selected target for $text", async ({ text, expected }) => {
  const onQueue = vi.fn(async () => true);
  const user = userEvent.setup();
  const { field } = setup({ running: true, onQueue });
  await user.type(field, text);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: /queue/i }));
  expect(onQueue).toHaveBeenCalledWith(text, expected);
});

/** Option rows of the mention list alone — the agent picker also renders options. */
function mentionRows(): string[] {
  const list = document.querySelector(".mention-popup");
  if (!list) return [];
  return [...list.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? "");
}

it("opens the list on @ and narrows it as the name is typed", async () => {
  const user = userEvent.setup();
  const { field } = setup();
  await user.click(field);
  await user.keyboard("@");
  expect(mentionRows()).toEqual(["Ada", "Alan"]);
  await user.keyboard("Al");
  expect(mentionRows()).toEqual(["Alan"]);
});

it("reopens the list when the composer is focused again after a blur", async () => {
  const user = userEvent.setup();
  const { field } = setup();
  await user.click(field);
  await user.keyboard("@A");
  expect(mentionRows()).toEqual(["Ada", "Alan"]);
  // Clicking the transcript, the agent picker, or another window blurs the
  // draft. That must hide the list, never retire the fragment: a draft the
  // author comes back to and keeps typing is still an open mention.
  act(() => field.blur());
  expect(mentionRows()).toEqual([]);
  await user.click(field);
  await user.keyboard("l");
  expect(mentionRows()).toEqual(["Alan"]);
});

it("keeps the list closed while the dismissed name is still being typed", async () => {
  const user = userEvent.setup();
  const { field } = setup();
  await user.click(field);
  await user.keyboard("@A");
  await user.keyboard("{Escape}");
  expect(mentionRows()).toEqual([]);
  // Escape means "I know the name" — finishing it must not re-open the list.
  await user.keyboard("l");
  expect(mentionRows()).toEqual([]);
});

it("opens again for a fresh @ typed where a dismissed one was", async () => {
  const user = userEvent.setup();
  const { field } = setup();
  await user.click(field);
  await user.keyboard("@A");
  await user.keyboard("{Escape}");
  // Deleting the fragment ends it. The next `@` is a new mention, even at the
  // same offset, and a dismissal keyed on that offset used to bury it for the
  // rest of the draft.
  await user.keyboard("{Backspace}{Backspace}");
  expect(field.value).toBe("");
  await user.keyboard("@");
  expect(mentionRows()).toEqual(["Ada", "Alan"]);
});

it.each([
  { addressTeamId: "crew" },
  {},
])("keeps the selected team or Project room when queueing: %j", async (expected) => {
  const onQueue = vi.fn(async () => true);
  const team = "addressTeamId" in expected;
  const user = userEvent.setup();
  const { field } = setup({ running: true, onQueue,
    ...(team ? { activeTeamId: "crew", teams: [{ id: "crew", name: "Crew", enabled: true, members: AGENTS, leadAgentId: "a1" } as any] }
      : { projectName: "Project", projectRoomSelected: true, projectRoom: { agentIds: ["a1", "a2"], crewAgentIds: ["a1", "a2"] } as any }),
  });
  await user.type(field, "Continue");
  await user.click(screen.getByRole("button", { name: /queue/i }));
  expect(onQueue).toHaveBeenCalledWith("Continue", expected);
});
