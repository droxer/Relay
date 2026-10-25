import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AwaitingInputPrompt } from "../src/components/AwaitingInputPrompt";
import { Composer, type ComposerHandle } from "../src/components/composer/Composer";

type Waiting = Parameters<typeof AwaitingInputPrompt>[0]["waiting"];

function setup(
  onSend: (...args: unknown[]) => Promise<boolean>,
  options = ["Staging", "Production"],
  waiting: Waiting = { kind: "question", text: "Which environment?", options, notes: [] },
  onMarkDone?: () => Promise<boolean>,
) {
  const ref = createRef<ComposerHandle>();
  const onReply = vi.fn();
  render(<Composer
    ref={ref}
    logicalAgents={[]}
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
    onSend={onSend}
    onCancelRun={vi.fn()}
    prompt={<AwaitingInputPrompt
      waiting={waiting}
      agentName="Ada"
      onChoose={(reply, sendOptions) => ref.current?.send(reply, sendOptions) ?? Promise.resolve(false)}
      onReply={onReply}
      onMarkDone={onMarkDone}
    />}
  />);
  return { ref, onReply };
}

it("allows another choice and a custom reply after dispatch rejects an answer", async () => {
  let finish!: (sent: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const { ref, onReply } = setup(onSend);
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(ref.current?.getText()).toBe("Staging");
  expect((screen.getByRole("button", { name: "Production" }) as HTMLButtonElement).disabled).toBe(true);
  finish(false);
  await waitFor(() => expect((screen.getByRole("button", { name: "Production" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "awaiting.write_own" }));
  expect(onReply).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  finish(false);
  await waitFor(() => expect((screen.getByRole("button", { name: "Production" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3));
  expect(ref.current?.getText()).toBe("Production");
  finish(true);
});

it("sends an answer that starts with @ as plain text, not as a mention", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, ["@Unknown deploy", "Staging"]);
  fireEvent.click(screen.getByRole("button", { name: "@Unknown deploy" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenLastCalledWith(undefined, undefined, { literal: true });
});

it("puts the box back exactly as it was when a picked answer fails", async () => {
  const onSend = vi.fn(async () => false);
  const { ref } = setup(onSend);
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect(ref.current?.getText()).toBe(""));
  await waitFor(() => expect((screen.getByRole("button", { name: "Staging" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, wait" } });
  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(ref.current?.getText()).toBe("Actually, wait"));
});

it("unlocks the prompt when dispatch throws", async () => {
  const onSend = vi.fn(async () => { throw new Error("dispatch failed"); });
  setup(onSend);
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect((screen.getByRole("button", { name: "Production" }) as HTMLButtonElement).disabled).toBe(false));
});

it("puts a half-typed draft back after a picked answer is sent", async () => {
  const onSend = vi.fn(async () => true);
  const { ref } = setup(onSend);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, wait" } });
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect(ref.current?.getText()).toBe("Actually, wait"));
});

it("picks an answer by its number key, but never while someone is typing", async () => {
  const onSend = vi.fn(async () => true);
  const { ref } = setup(onSend);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "1" });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "2" });
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(ref.current?.getText()).toBe("Production");
});

it("leaves number keys alone while focus is on another control or a modifier is held", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend);
  const elsewhere = document.createElement("button");
  elsewhere.textContent = "Open settings";
  document.body.append(elsewhere);
  elsewhere.focus();
  fireEvent.keyDown(elsewhere, { key: "1" });
  elsewhere.blur();
  fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "1", metaKey: true });
  fireEvent.keyDown(document.body, { key: "1", altKey: true });
  elsewhere.remove();
  expect(onSend).not.toHaveBeenCalled();
  // Inside the prompt the keys are the prompt's own.
  const first = screen.getByRole("button", { name: "Staging" });
  first.focus();
  fireEvent.keyDown(first, { key: "2" });
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
});

it("announces the prompt once, after it has appeared", async () => {
  setup(vi.fn(async () => true));
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("");
  await waitFor(() => expect(status.textContent).toBe("awaiting.question_title"));
});

it("asks for status without handing the agent a task round", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, [], { kind: "check", text: "A required step failed to run.", options: [], notes: [] });
  fireEvent.click(screen.getByRole("button", { name: "awaiting.choice_status" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenLastCalledWith(undefined, "discuss", { literal: true });
});

it("sends keep-going as an ordinary reply that resumes the work", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, [], { kind: "check", text: "A required step failed to run.", options: [], notes: [] });
  fireEvent.click(screen.getByRole("button", { name: "awaiting.choice_continue" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenLastCalledWith(undefined, undefined, { literal: true });
});

it("folds what else held the work up behind one line under the question", () => {
  setup(vi.fn(async () => true), ["Staging", "Production"], {
    kind: "question", text: "Which environment?", options: ["Staging", "Production"],
    notes: ["A required step failed to run."],
  });
  const summary = screen.getByText("awaiting.notes_summary");
  const details = summary.closest("details");
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain("A required step failed to run.");
});

it("says what happens once a pick went through, in place of the answers", async () => {
  setup(vi.fn(async () => true));
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(screen.getByText("awaiting.sent_resume")).toBeTruthy());
  expect(screen.queryByRole("list", { name: "awaiting.choices" })).toBeNull();
  expect(screen.queryByRole("button", { name: "awaiting.write_own" })).toBeNull();
});

it("tells a gate stop's choices apart by what each does to the work", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, [], { kind: "check", text: "A required step failed to run.", options: [], notes: [] });
  const status = screen.getByRole("button", { name: "awaiting.choice_status" });
  expect(document.getElementById(status.getAttribute("aria-describedby") ?? "")?.textContent).toBe("awaiting.effect_stays");
  fireEvent.click(status);
  await waitFor(() => expect(screen.getByText("awaiting.sent_discuss")).toBeTruthy());
});

it("points an unreported stop at the agent's last message instead of quoting the gate", () => {
  setup(vi.fn(async () => true), [], {
    kind: "check", text: "A required step ended without reporting what it did.", options: [], notes: [], unreported: true,
  });
  expect(screen.getByRole("heading", { name: "awaiting.unreported_title" })).toBeTruthy();
  expect(screen.getByText("awaiting.unreported_text")).toBeTruthy();
  expect(screen.queryByText("A required step ended without reporting what it did.")).toBeNull();
  expect(screen.getByRole("button", { name: "awaiting.choice_continue" })).toBeTruthy();
});

const task = { id: "task_2", number: 2 } as NonNullable<Waiting["task"]>;
const unreportedCheck: Waiting = {
  kind: "check", text: "A required step ended without reporting what it did.", options: [], notes: [], unreported: true, task,
};

it("lets the person close a stopped task as done without sending the agent anything", async () => {
  const onSend = vi.fn(async () => true);
  const onMarkDone = vi.fn(async () => true);
  setup(onSend, [], unreportedCheck, onMarkDone);
  fireEvent.click(screen.getByRole("button", { name: "awaiting.choice_mark_done" }));
  await waitFor(() => expect(onMarkDone).toHaveBeenCalledOnce());
  expect(onSend).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText("awaiting.sent_done")).toBeTruthy());
});

it("marks the task done by its number key and unlocks the prompt if that fails", async () => {
  const onMarkDone = vi.fn(async () => false);
  setup(vi.fn(async () => true), [], unreportedCheck, onMarkDone);
  fireEvent.keyDown(document.body, { key: "3" });
  await waitFor(() => expect(onMarkDone).toHaveBeenCalledOnce());
  await waitFor(() => expect((screen.getByRole("button", { name: "awaiting.choice_continue" }) as HTMLButtonElement).disabled).toBe(false));
});

it("offers mark done only for a stop on a task, never beside an agent's own answers", () => {
  const onMarkDone = vi.fn(async () => true);
  setup(vi.fn(async () => true), ["Staging", "Production"], undefined, onMarkDone);
  expect(screen.queryByRole("button", { name: "awaiting.choice_mark_done" })).toBeNull();
});

it("offers no mark done for a thread with no task", () => {
  setup(vi.fn(async () => true), [], { ...unreportedCheck, task: undefined }, vi.fn(async () => true));
  expect(screen.queryByRole("button", { name: "awaiting.choice_mark_done" })).toBeNull();
});
