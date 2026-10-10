import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AwaitingInputPrompt } from "../src/components/AwaitingInputPrompt";
import { Composer, type ComposerHandle } from "../src/components/composer/Composer";

function setup(onSend: () => Promise<boolean>, options = ["Staging", "Production"]) {
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
      waiting={{ kind: "question", text: "Which environment?", options }}
      agentName="Ada"
      onChoose={(reply) => ref.current?.send(reply) ?? Promise.resolve(false)}
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
