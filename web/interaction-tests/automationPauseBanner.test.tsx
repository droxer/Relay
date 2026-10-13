import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AutomationPauseBanner } from "../src/components/task-board/AutomationPauseBanner";
import { canManageAutomation } from "../src/components/task-record/recordActions";

const { resumeAutomation, announce } = vi.hoisted(() => ({
  resumeAutomation: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("../src/api", () => ({ resumeAutomation, RelayApiError: class extends Error {} }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce }) }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));

const PAUSED = { id: "R-7", routineState: "paused_by_relay", routinePauseReason: "failing" } as const;

function renderBanner(node: ReactNode) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  resumeAutomation.mockReset();
  announce.mockReset();
});

it("explains a failing pause and resumes through the resume route", async () => {
  resumeAutomation.mockResolvedValue({ ...PAUSED, routineState: "active", routinePauseReason: undefined,
    title: "Nightly", status: "backlog", linkedSessionIds: [], events: [], activity: [],
    updatedAt: "2026-10-13T09:00:00Z" });
  renderBanner(<AutomationPauseBanner task={PAUSED} canResume />);
  expect(screen.getByText("automation.paused_reasons.failing")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "automation.resume" }));
  await waitFor(() => expect(resumeAutomation).toHaveBeenCalledWith("R-7"));
  await waitFor(() => expect(announce).toHaveBeenCalledWith({ message: "automation.resumed_toast", tone: "success" }));
});

it("offers no Resume to someone who cannot manage the automation", () => {
  renderBanner(<AutomationPauseBanner task={PAUSED} canResume={false} />);
  expect(screen.getByText("automation.paused_reasons.failing")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "automation.resume" })).toBeNull();
});

it("renders nothing for an automation Relay did not pause", () => {
  renderBanner(<AutomationPauseBanner task={{ ...PAUSED, routineState: "paused" }} canResume />);
  expect(screen.queryByRole("status")).toBeNull();
});

it("lets only the owner or an admin manage an automation", () => {
  const task = { ownerEmployeeId: "fei" };
  expect(canManageAutomation(task, { role: "user", employeeId: "fei" })).toBe(true);
  expect(canManageAutomation(task, { role: "admin", employeeId: "ops" })).toBe(true);
  expect(canManageAutomation(task, { role: "user", employeeId: "bob" })).toBe(false);
  expect(canManageAutomation({}, { role: "user" })).toBe(false);
});
