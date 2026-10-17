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
  const allow = screen.getByRole("button", { name: /permission.allow/ });
  expect(document.activeElement).toBe(allow);

  fireEvent.change(screen.getByLabelText("permission.note_label"), { target: { value: "  Use a temp dir  " } });
  fireEvent.click(screen.getByRole("button", { name: "permission.deny" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("perm_00000001", "deny", "Use a temp dir"));
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
