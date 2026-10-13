import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AutomationPauseBanner } from "../src/components/task-board/AutomationPauseBanner";
import { canManageAutomation } from "../src/components/task-record/recordActions";
import { useRelayMutations } from "../src/hooks/useRelayMutations";

const { resumeAutomation, announce } = vi.hoisted(() => ({
  resumeAutomation: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("../src/api", () => ({ resumeAutomation, RelayApiError: class extends Error {} }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce }) }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));

const PAUSED = { id: "R-7", routineState: "paused_by_relay", routinePauseReason: "failing" } as const;

beforeEach(() => {
  resumeAutomation.mockReset();
  announce.mockReset();
});

it("explains a failing pause and offers Resume", async () => {
  const onResume = vi.fn();
  render(<AutomationPauseBanner task={PAUSED} onResume={onResume} />);
  expect(screen.getByText("automation.paused_reasons.failing")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "automation.resume" }));
  expect(onResume).toHaveBeenCalledTimes(1);
});

it("holds Resume while a record action is in flight", () => {
  render(<AutomationPauseBanner task={PAUSED} onResume={vi.fn()} busy />);
  expect((screen.getByRole("button", { name: "automation.resume" }) as HTMLButtonElement).disabled).toBe(true);
});

it("offers no Resume to someone who cannot manage the automation", () => {
  render(<AutomationPauseBanner task={PAUSED} />);
  expect(screen.getByText("automation.paused_reasons.failing")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "automation.resume" })).toBeNull();
});

it("renders nothing for an automation Relay did not pause", () => {
  render(<AutomationPauseBanner task={{ ...PAUSED, routineState: "paused" }} onResume={vi.fn()} />);
  expect(screen.queryByRole("status")).toBeNull();
});

it("resumes through the resume route and says so", async () => {
  resumeAutomation.mockResolvedValue({ ...PAUSED, routineState: "active", title: "Nightly", status: "backlog",
    linkedSessionIds: [], events: [], activity: [], updatedAt: "2026-10-13T09:00:00Z" });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useRelayMutations(), { wrapper });
  await act(async () => { await view.result.current.resumeAutomationMutation.mutateAsync({ taskId: "R-7" }); });
  expect(resumeAutomation).toHaveBeenCalledWith("R-7");
  expect(announce).toHaveBeenCalledWith({ message: "automation.resumed_toast", tone: "success" });
  client.clear();
});

it("lets only the owner or an admin manage an automation", () => {
  const task = { ownerEmployeeId: "fei" };
  expect(canManageAutomation(task, { role: "user", employeeId: "fei" })).toBe(true);
  expect(canManageAutomation(task, { role: "admin", employeeId: "ops" })).toBe(true);
  expect(canManageAutomation(task, { role: "user", employeeId: "bob" })).toBe(false);
  expect(canManageAutomation({}, { role: "user" })).toBe(false);
});
