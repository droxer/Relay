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
) {
  const ref = createRef<ComposerHandle>();
  const onReply = vi.fn();
  render(<Composer
    ref={ref}
    logicalAgents={[]}
    onLogicalAgentPicked={vi.fn()}
    activeAgentDisplayName="Ada"
    selectedEmployee="emp"
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

it("unlocks the prompt when an answer fails local mention validation", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, ["@Unknown deploy", "Staging"]);
  fireEvent.click(screen.getByRole("button", { name: "@Unknown deploy" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Staging" }) as HTMLButtonElement).disabled).toBe(false));
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Staging" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
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

it("asks for status without handing the agent a task round", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, [], { kind: "check", text: "A required step failed to run.", options: [], notes: [] });
  fireEvent.click(screen.getByRole("button", { name: "awaiting.choice_status" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenLastCalledWith(undefined, "discuss");
});

it("sends keep-going as an ordinary reply that resumes the work", async () => {
  const onSend = vi.fn(async () => true);
  setup(onSend, [], { kind: "check", text: "A required step failed to run.", options: [], notes: [] });
  fireEvent.click(screen.getByRole("button", { name: "awaiting.choice_continue" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenLastCalledWith(undefined);
});

it("shows what else held the work up under the question", () => {
  setup(vi.fn(async () => true), ["Staging", "Production"], {
    kind: "question", text: "Which environment?", options: ["Staging", "Production"],
    notes: ["A required step failed to run."],
  });
  expect(screen.getByRole("group", { name: "awaiting.notes_title" }).textContent).toContain("A required step failed to run.");
});
