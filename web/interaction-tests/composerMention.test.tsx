import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import { Composer } from "../src/components/composer/Composer";
import type { MentionCandidate } from "../src/lib/mentions";
import type { AgentTeam, UserAgent } from "../src/types";

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
  const composer = (props: Partial<React.ComponentProps<typeof Composer>>) => (
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
      {...props}
    />
  );
  const view = render(composer(overrides));
  return {
    field: screen.getByRole("textbox") as HTMLTextAreaElement,
    rerender: (props: Partial<React.ComponentProps<typeof Composer>>) => view.rerender(composer({ ...overrides, ...props })),
  };
}

it("requires an active Workflow to start a Thread with a retired Team default", async () => {
  const onSend = vi.fn(async () => false);
  const team = { id: "crew", name: "Crew", enabled: true, members: AGENTS, memberAgentIds: ["a1", "a2"],
    leadAgentId: "a1", defaultWorkflowId: "preset:pipeline" } as AgentTeam;
  const { field } = setup({ initializingThread: true, activeTeamId: team.id, teams: [team], onSend });
  fireEvent.change(field, { target: { value: "Start with the Team" } });
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "composer.send" });
  expect(send.disabled).toBe(true);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("combobox", { name: "workflow.select_workflow" }));
  await userEvent.click(await screen.findByRole("option", { name: /collab_style.lead_led/ }));
  await userEvent.click(send);
  expect(onSend).toHaveBeenCalledWith("lead_led", undefined, expect.any(Object));
});

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

it("keeps a queue submission locked when the current run finishes before acknowledgement", async () => {
  let accept!: (value: boolean) => void;
  const onQueue = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
  const onSend = vi.fn();
  const { field, rerender } = setup({ running: true, onQueue, onSend });
  fireEvent.change(field, { target: { value: "One follow-up" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onQueue).toHaveBeenCalledTimes(1);

  rerender({ running: false });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();

  await act(async () => { accept(true); });
  expect(field.value).toBe("");
});

it("keeps direct send locked until a slow request settles", async () => {
  vi.useFakeTimers();
  try {
    let reject!: (value: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { reject = resolve; }));
    const { field } = setup({ onSend });
    fireEvent.change(field, { target: { value: "One message" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(() => vi.advanceTimersByTimeAsync(4_001));

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => { reject(false); });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    await act(async () => { reject(false); });
  } finally {
    vi.useRealTimers();
  }
});

it("offers the saved send separately from the next draft", async () => {
  const retry = vi.fn(async () => true);
  const onSend = vi.fn();
  const { field, rerender } = setup({
    onSend,
    messageRetry: { text: "Original message", busy: false, retry, dismiss: vi.fn() },
  });
  expect(screen.getByText("Original message").textContent).toBe("Original message");
  fireEvent.change(field, { target: { value: "New draft" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "composer.retry_send" }));
  expect(retry).toHaveBeenCalledTimes(1);
  rerender({ messageRetry: null });
  expect(field.value).toBe("New draft");
});
