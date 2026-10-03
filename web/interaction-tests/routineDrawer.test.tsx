import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, emptyRoutineForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { CurrentUser, ProjectRecord } from "../src/types";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => children }));
vi.mock("../src/components/assignment/AssignmentField", () => ({ AssignmentField: () => <div data-testid="assignment" /> }));

const user = { employeeId: "u", username: "u" } as CurrentUser;
const projects = [{ id: "p", name: "Launch", enabled: true, members: [] }] as unknown as ProjectRecord[];

function Form({ initial, projectChoice, save = vi.fn() }: {
  initial: TaskBoardFormState;
  projectChoice?: "required" | "optional" | "locked";
  save?: () => void;
}) {
  const [form, setForm] = useState(initial);
  return <TaskDrawer open form={form} projectChoice={projectChoice} onChange={setForm} onSubmit={save} onClose={vi.fn()}
    saving={false} title="Routine" subtitle="Draft" projects={projects} logicalAgents={[]} teams={[]} />;
}

const schedule = () => screen.getByRole("group", { name: "routine.schedule" });
const enabledSwitch = () => within(schedule()).getByRole("switch", { name: "routine.enabled" });
const enabledHint = () => document.getElementById(enabledSwitch().getAttribute("aria-describedby")!);

it("groups type, cadence, next run, and the enabled switch as one schedule", () => {
  render(<Form initial={emptyRoutineForm(user)} />);
  expect(within(schedule()).getByText("routine.type")).toBeTruthy();
  expect(within(schedule()).getByText("routine.cadence")).toBeTruthy();
  expect(within(schedule()).getByText("routine.next_run")).toBeTruthy();
  expect(enabledSwitch()).toBeTruthy();
});

it("says why the schedule cannot be turned on while nothing could run it", () => {
  render(<Form initial={emptyRoutineForm(user)} />);
  const toggle = enabledSwitch();
  const disabled = toggle.getAttribute("aria-disabled") === "true" || toggle.hasAttribute("data-disabled") || (toggle as HTMLButtonElement).disabled;
  expect(disabled).toBe(true);
  expect(enabledHint()?.textContent).toBe("routine.enabled_needs_target");
});

it("keeps the ordinary pause hint once the routine has a project", () => {
  render(<Form initial={{ ...emptyRoutineForm(user), projectId: "p" }} />);
  expect(enabledHint()?.textContent).toBe("routine.enabled_hint");
});

it("explains that a cadence sets the next run, and drops that once the cadence is custom", () => {
  const { unmount } = render(<Form initial={emptyRoutineForm(user)} />);
  expect(screen.getByText("routine.next_run_auto_hint")).toBeTruthy();
  unmount();
  render(<Form initial={{ ...emptyRoutineForm(user), routineCadence: "custom", routineNextRunDate: "" }} />);
  expect(screen.getByText("routine.next_run_hint")).toBeTruthy();
  expect(screen.queryByText("routine.next_run_auto_hint")).toBeNull();
});

it("says why the acceptance policy is locked once the task has started", () => {
  render(<Form initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "p", startedAt: "2026-10-01T10:00:00.000Z" } as TaskBoardFormState} />);
  expect(screen.getByText("backlog.acceptance_locked")).toBeTruthy();
});

it("shows no lock hint before the task has started", () => {
  render(<Form initial={{ ...emptyBacklogForm(user), title: "Ship", projectId: "p" }} />);
  expect(screen.queryByText("backlog.acceptance_locked")).toBeNull();
});

it("shows a saved task's project as a labelled read-only field", () => {
  render(<Form projectChoice="locked" initial={{ ...emptyRoutineForm(user), id: "task_1", title: "Audit", projectId: "p" }} />);
  const field = screen.getByText("Launch").closest("[data-slot='field']") as HTMLElement;
  expect(within(field).getByText("project.projects")).toBeTruthy();
  expect(within(field).getByText("project.locked_hint")).toBeTruthy();
});

it("reports a missing title in the drawer's own words", () => {
  const save = vi.fn();
  render(<Form save={save} initial={{ ...emptyRoutineForm(user), projectId: "p" }} />);
  fireEvent.click(screen.getByRole("button", { name: "routine.create" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("backlog.title_required")).toBeTruthy();
});

it("shows event filters and hides cadence for task-event automations", () => {
  render(<Form initial={{ ...emptyRoutineForm(user), routineTrigger: { kind: "task_event", on: "status_changed" } }} />);
  expect(screen.getByText("automation.trigger_kind")).toBeTruthy();
  const filters = screen.getByRole("group", { name: "automation.filters_legend" });
  expect(within(filters).getByText("automation.filter_from_status")).toBeTruthy();
  expect(screen.getByText("automation.filter_to_status")).toBeTruthy();
  expect(screen.queryByText("routine.cadence")).toBeNull();
  expect(screen.queryByText("routine.next_run")).toBeNull();
});

it("shows a save-first hint for a new webhook automation", () => {
  render(<Form initial={{ ...emptyRoutineForm(user), routineTrigger: { kind: "webhook" } }} />);
  expect(screen.getByText("automation.webhook_save_first")).toBeTruthy();
  expect(screen.queryByText("routine.cadence")).toBeNull();
});

it("explains manual runs and rate-limited pauses", () => {
  render(<Form initial={{ ...emptyRoutineForm(user), projectId: "p", routineTrigger: { kind: "manual" }, routineDisabledReason: "rate_limited" }} />);
  expect(screen.getByText("automation.manual_hint")).toBeTruthy();
  expect(enabledHint()?.textContent).toBe("automation.rate_limited");
});

it("validates an edited title filter without changing the input snapshot", () => {
  const initial = { ...emptyRoutineForm(user), routineTrigger: { kind: "task_event" as const, on: "created" as const } };
  render(<Form initial={initial} />);
  fireEvent.change(screen.getByRole("textbox", { name: "automation.filter_title" }), { target: { value: "x".repeat(121) } });
  expect(screen.getByText("automation.errors.title_too_long")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "automation.filter_title" }).getAttribute("aria-invalid")).toBe("true");
  expect(initial.routineTrigger).toEqual({ kind: "task_event", on: "created" });
});
