import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PermissionRequest } from "relay-core";
import { PermissionPrompts } from "../src/components/composer/PermissionPrompts";

const request: PermissionRequest = {
  id: "perm_00000001",
  runId: "run_1",
  agent: "claude",
  toolName: "Bash",
  input: "{\"command\":\"make clean\"}",
  requestedAt: "2026-10-17T00:00:00.000Z",
};

it("shows what the run wants to do and sends the person's answer with a note", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<PermissionPrompts requests={[request]} agentLabel={() => "Builder"} onAnswer={onAnswer} />);
  expect(screen.getByText(/make clean/)).toBeTruthy();
  const allow = screen.getByRole("button", { name: "permission.allow" });
  expect(document.activeElement).toBe(allow);

  fireEvent.change(screen.getByLabelText("permission.note_label"), { target: { value: "  Use a temp dir  " } });
  fireEvent.click(screen.getByRole("button", { name: "permission.deny" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("perm_00000001", { decision: "deny", note: "Use a temp dir", answers: undefined, always: undefined }));
});

it("allows a tool always for the rest of the thread", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<PermissionPrompts requests={[request]} agentLabel={() => "Builder"} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole("button", { name: "permission.allow_always_hint" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("perm_00000001", { decision: "allow", note: undefined, answers: undefined, always: true }));
});

it("leaves the caret alone when a prompt lands while someone is typing", () => {
  const draft = document.createElement("textarea");
  document.body.appendChild(draft);
  draft.focus();
  try {
    render(<PermissionPrompts requests={[request]} agentLabel={() => "Builder"} onAnswer={vi.fn()} />);
    expect(document.activeElement).toBe(draft);
    expect(screen.getByRole("status").textContent).toBe("");
  } finally {
    draft.remove();
  }
});

const question: PermissionRequest = {
  ...request,
  id: "perm_00000002",
  toolName: "AskUserQuestion",
  input: "{}",
  questions: [{ id: "Which database?", text: "Which database?", options: [{ label: "Postgres", description: "shared" }, { label: "SQLite" }] }],
};

it("answers a single question on the pick, the way the agent's own prompt would", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  render(<PermissionPrompts requests={[question]} agentLabel={() => "Builder"} onAnswer={onAnswer} />);
  expect(screen.getByText("Which database?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /permission.allow/ })).toBeNull();
  // A question needs its person every time: it is never allowed ahead.
  const sqlite = screen.getByRole("radio", { name: /SQLite/ });
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Postgres/ }));
  fireEvent.click(sqlite);
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("perm_00000002", { decision: "allow", note: undefined, answers: { "Which database?": ["SQLite"] }, always: undefined }));
});

it("collects several picks and a written answer until Answer, and Skip sends none", async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  const multi: PermissionRequest = {
    ...question,
    questions: [
      { ...question.questions![0], multiSelect: true },
      { id: "name", text: "Service name?", options: [] },
    ],
  };
  render(<PermissionPrompts requests={[multi]} agentLabel={() => "Builder"} onAnswer={onAnswer} />);
  const answer = screen.getByRole("button", { name: /permission.answer$/ });
  expect((answer as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Postgres/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /SQLite/ }));
  expect((answer as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("permission.answer_label"), { target: { value: " relay " } });
  expect((answer as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(answer);
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("perm_00000002", { decision: "allow", note: undefined, answers: { "Which database?": ["Postgres", "SQLite"], name: ["relay"] }, always: undefined }));
  fireEvent.click(screen.getByRole("button", { name: "permission.skip" }));
  await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith("perm_00000002", { decision: "deny", note: undefined, answers: undefined, always: undefined }));
});

it("asks for a reason only where the runtime passes it to the agent", () => {
  render(<PermissionPrompts requests={[{ ...request, agent: "codex", toolName: "apply_patch" }]} agentLabel={() => "Builder"} onAnswer={vi.fn()} />);
  expect(screen.queryByLabelText("permission.note_label")).toBeNull();
  expect(screen.getByRole("button", { name: "permission.deny" })).toBeTruthy();
});

it("renders nothing while no run is waiting", () => {
  const { container } = render(<PermissionPrompts requests={[]} agentLabel={() => "Builder"} onAnswer={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});
