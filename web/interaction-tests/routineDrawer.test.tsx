import { createContext, useContext, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { AUTH_CAPABILITIES_QUERY_KEY } from "../src/hooks/useAuthSession";
import { emptyBacklogForm, emptyRoutineForm, routineMutationFields, type RoutineTaskFormState, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import type { AgentTeam, CurrentUser, UserAgent, ProjectRecord, RoutineTrigger } from "../src/types";

const { previewSchedule } = vi.hoisted(() => ({
  previewSchedule: vi.fn(),
}));

vi.mock("../src/api", () => ({
  previewSchedule,
  webhookSecretStatus: vi.fn(async () => ({ configured: false, path: "/hook", header: "X-Relay-Secret" })),
  rotateWebhookSecret: vi.fn(),
  RelayApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => children }));
vi.mock("../src/components/assignment/AssignmentField", () => ({
  AssignmentField: ({ onSelect }: { onSelect: (selection: { kind: string; id?: string }) => void }) => (
    <div data-testid="assignment">
      <button type="button" onClick={() => onSelect({ kind: "agent", id: "agent-1" })}>pick agent</button>
      <button type="button" onClick={() => onSelect({ kind: "team", id: "team-1" })}>pick team</button>
    </div>
  ),
}));
/* base-ui's Select portals and animates in jsdom; a context stand-in keeps
   every option on the page and clickable. */
vi.mock("@/components/ui/select", () => {
  type Choice = { value: unknown; onValueChange?: (value: unknown) => void };
  const SelectContext = createContext<Choice>({ value: undefined });
  return {
    Select: ({ value, onValueChange, children }: Choice & { children: ReactNode }) =>
      <SelectContext.Provider value={{ value, onValueChange }}>{children}</SelectContext.Provider>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children?: ReactNode | ((value: unknown) => ReactNode) }) => {
      const { value } = useContext(SelectContext);
      return <span data-testid="select-value">{typeof children === "function" ? children(value) : String(value)}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: unknown; children: ReactNode }) => {
      const choice = useContext(SelectContext);
      return <button type="button" role="option" aria-selected={choice.value === value}
        onClick={() => choice.onValueChange?.(value)}>{children}</button>;
    },
  };
});

const user = { userId: "u", username: "u" } as CurrentUser;
const projects = [{ id: "p", name: "Launch", enabled: true, members: [] }] as unknown as ProjectRecord[];
const agents = [{ id: "agent-1", displayName: "Builder", executorKind: "codex", supervisorUserId: "u" }] as unknown as UserAgent[];
const teams = [{ id: "team-1", name: "Crew", ownerUserId: "u", members: [] }] as unknown as AgentTeam[];
const WEEKDAYS_9: RoutineTrigger = { kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "weekday", at: "09:00" } } };

beforeEach(() => {
  seen.form = null;
  session.capabilities = { automationTriggers: true };
  previewSchedule.mockResolvedValue({ summary: "Weekdays at 09:00", next: ["2026-10-14T09:00:00+00:00"] });
});

/** What the session probe left in the capabilities cache; undefined = not yet. */
const session: { capabilities?: { automationTriggers: boolean } } = {};

/** The form as the drawer last reported it, through onChange. */
const seen: { form: TaskBoardFormState | null } = { form: null };
const latest = () => seen.form as RoutineTaskFormState;

function Form({ initial, projectChoice, save = vi.fn() }: {
  initial: TaskBoardFormState;
  projectChoice?: "required" | "optional" | "locked";
  save?: () => void;
}) {
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (session.capabilities) queryClient.setQueryData(AUTH_CAPABILITIES_QUERY_KEY, session.capabilities);
    return queryClient;
  });
  const [form, setForm] = useState(initial);
  const change = (next: TaskBoardFormState) => {
    seen.form = next;
    setForm(next);
  };
  return (
    <QueryClientProvider client={client}>
      <TaskDrawer open form={form} projectChoice={projectChoice} onChange={change} onSubmit={save} onClose={vi.fn()}
        saving={false} title="Routine" subtitle="Draft" projects={projects} logicalAgents={agents} teams={teams} />
    </QueryClientProvider>
  );
}

function routine(extra: Partial<RoutineTaskFormState>): RoutineTaskFormState {
  return { ...emptyRoutineForm(user), ...extra };
}

const kindField = () => screen.getByText("automation.trigger_kind").closest("[data-slot='field']") as HTMLElement;
const kindOptions = () => within(kindField()).getAllByRole("option").map((option) => option.textContent);
const schedule = () => screen.getByRole("group", { name: "routine.schedule" });
const enabledSwitch = () => within(schedule()).getByRole("switch", { name: "routine.enabled" });
const enabledHint = () => document.getElementById(enabledSwitch().getAttribute("aria-describedby")!);

it("groups the trigger, its schedule, and the enabled switch as one section", () => {
  render(<Form initial={emptyRoutineForm(user)} />);
  expect(within(schedule()).getByText("automation.trigger_kind")).toBeTruthy();
  expect(within(schedule()).getByText("automation.repeat")).toBeTruthy();
  expect(within(schedule()).getByText("automation.timezone")).toBeTruthy();
  expect(enabledSwitch()).toBeTruthy();
});

it("previews the next fire of a valid schedule", async () => {
  render(<Form initial={routine({ routineTriggers: [WEEKDAYS_9] })} />);
  expect(await screen.findByText(/Weekdays at 09:00 · automation.preview_next/)).toBeTruthy();
  expect(previewSchedule).toHaveBeenCalledWith(WEEKDAYS_9.kind === "schedule" ? WEEKDAYS_9.schedule : null, expect.anything());
});

it("shows the server's refusal of a schedule as the field error", async () => {
  previewSchedule.mockRejectedValue(new Error("schedule.repeat.cron fires more often than every 15 minutes."));
  render(<Form initial={routine({ routineTriggers: [{ kind: "schedule", schedule: { timezone: "UTC", repeat: { cron: "* * * * *" } } }] })} />);
  expect(await screen.findByText(/fires more often than every 15 minutes/)).toBeTruthy();
  await waitFor(() => expect(document.querySelector("[name='automation-cron']")?.getAttribute("aria-invalid")).toBe("true"));
});

it("checks a schedule locally before asking the server", () => {
  render(<Form initial={routine({ routineTriggers: [WEEKDAYS_9] })} />);
  fireEvent.change(document.querySelector("[name='automation-at']")!, { target: { value: "" } });
  expect(screen.getByText("automation.errors.time")).toBeTruthy();
});

it("keeps the time when the preset changes, and requires a day for a weekly schedule", () => {
  render(<Form initial={routine({ routineTriggers: [{ kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "day", at: "07:45" } } }] })} />);
  fireEvent.click(screen.getByRole("option", { name: "automation.presets.week" }));
  const [trigger] = latest().routineTriggers;
  expect(trigger.kind === "schedule" && trigger.schedule.repeat).toEqual({ every: "week", at: "07:45", days: [1] });
  fireEvent.click(screen.getByRole("button", { name: "automation.weekdays.1" }));
  expect(screen.getByText("automation.errors.days")).toBeTruthy();
});

it("offers Run now only, and saves it as no triggers", () => {
  render(<Form initial={emptyRoutineForm(user)} />);
  fireEvent.click(within(kindField()).getByRole("option", { name: "automation.kinds.none" }));
  expect(latest().routineTriggers).toEqual([]);
  expect(screen.getByText("automation.manual_hint")).toBeTruthy();
  expect(screen.queryByText("automation.repeat")).toBeNull();
});

it("offers only a schedule or Run now when the server switches triggers off", async () => {
  session.capabilities = { automationTriggers: false };
  render(<Form initial={emptyRoutineForm(user)} />);
  await waitFor(() => expect(kindOptions()).toEqual(["automation.kinds.schedule", "automation.kinds.none"]));
});

it("offers every trigger kind while the switch is unknown or on", () => {
  session.capabilities = undefined;
  render(<Form initial={emptyRoutineForm(user)} />);
  expect(kindOptions()).toEqual(["automation.kinds.schedule", "automation.kinds.task_event", "automation.kinds.run_event", "automation.kinds.webhook", "automation.kinds.none"]);
});

it("lists several triggers read-only and keeps them", () => {
  const triggers: RoutineTrigger[] = [WEEKDAYS_9, { kind: "webhook" }];
  render(<Form initial={routine({ routineTriggers: triggers })} />);
  expect(screen.getByText("automation.multi_trigger_readonly")).toBeTruthy();
  expect(screen.getByText("automation.presets.weekday")).toBeTruthy();
  expect(screen.getByText("automation.kinds.webhook")).toBeTruthy();
  expect(screen.queryByText("automation.trigger_kind")).toBeNull();
});

it("turns the switch on as active and off as paused", () => {
  render(<Form initial={routine({ projectId: "p" })} />);
  fireEvent.click(enabledSwitch());
  expect(latest().routineState).toBe("active");
  fireEvent.click(enabledSwitch());
  expect(latest().routineState).toBe("paused");
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

it("offers No project with an automation hint", () => {
  render(<Form initial={{ ...emptyRoutineForm(user), title: "Digest" }} />);
  expect(screen.getByText("routine.project_hint")).toBeTruthy();
  expect(screen.getAllByText("issues.no_project").length).toBeGreaterThan(0);
});

it("shows event filters and no schedule for task-event automations", () => {
  render(<Form initial={routine({ routineTriggers: [{ kind: "task_event", on: "status_changed" }] })} />);
  expect(screen.getByText("automation.trigger_kind")).toBeTruthy();
  const filters = screen.getByRole("group", { name: "automation.filters_legend" });
  expect(within(filters).getByText("automation.filter_from_status")).toBeTruthy();
  expect(screen.getByText("automation.filter_to_status")).toBeTruthy();
  expect(screen.queryByText("automation.repeat")).toBeNull();
});

it("shows a save-first hint for a new webhook automation", () => {
  render(<Form initial={routine({ routineTriggers: [{ kind: "webhook" }] })} />);
  expect(screen.getByText("automation.webhook_save_first")).toBeTruthy();
  expect(screen.queryByText("automation.repeat")).toBeNull();
});

it("explains a Relay pause above the switch, and resumes when it is turned on", () => {
  render(<Form initial={routine({ projectId: "p", routineTriggers: [], routineState: "paused_by_relay", routinePauseReason: "failing" })} />);
  expect(screen.getByText("automation.manual_hint")).toBeTruthy();
  expect(screen.getByText("automation.paused_reasons.failing")).toBeTruthy();
  fireEvent.click(enabledSwitch());
  expect(latest().routineState).toBe("active");
  expect(screen.queryByText("automation.paused_reasons.failing")).toBeNull();
});

it("validates an edited title filter without changing the input snapshot", () => {
  const initial = routine({ routineTriggers: [{ kind: "task_event", on: "created" }] });
  render(<Form initial={initial} />);
  fireEvent.change(screen.getByRole("textbox", { name: "automation.filter_title" }), { target: { value: "x".repeat(121) } });
  expect(screen.getByText("automation.errors.title_too_long")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "automation.filter_title" }).getAttribute("aria-invalid")).toBe("true");
  expect(initial.routineTriggers).toEqual([{ kind: "task_event", on: "created" }]);
});

it.each(["pick agent", "pick team"])("keeps a rate-limit pause when the reader picks a target (%s)", (pick) => {
  render(<Form initial={routine({ projectId: "p", routineState: "paused_by_relay", routinePauseReason: "rate_limited" })} />);
  fireEvent.click(screen.getByRole("button", { name: pick }));
  expect(latest().routineState).toBe("paused_by_relay");
  // The save body leaves the state out, so the server keeps its pause.
  expect("routineState" in routineMutationFields(latest())).toBe(false);
  expect(screen.getByText("automation.paused_reasons.rate_limited")).toBeTruthy();
});

it("resumes a no-target pause once the reader picks a target", () => {
  render(<Form initial={routine({ projectId: "p", routineState: "paused_by_relay", routinePauseReason: "no_target" })} />);
  fireEvent.click(screen.getByRole("button", { name: "pick agent" }));
  expect(latest().routineState).toBe("active");
  expect(routineMutationFields(latest()).routineState).toBe("active");
});

it("still turns an owner-paused automation on when a target is picked", () => {
  render(<Form initial={routine({ projectId: "p", routineState: "paused" })} />);
  fireEvent.click(screen.getByRole("button", { name: "pick team" }));
  expect(latest().routineState).toBe("active");
});

it("reads an emptied minute as invalid instead of saving 0", () => {
  render(<Form initial={routine({ routineTriggers: [{ kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "hour", minute: 30 } } }] })} />);
  fireEvent.change(document.querySelector("[name='automation-minute']")!, { target: { value: "" } });
  expect(screen.getByText("automation.errors.minute")).toBeTruthy();
  const [trigger] = latest().routineTriggers;
  expect(trigger.kind === "schedule" && Number.isNaN((trigger.schedule.repeat as { minute: number }).minute)).toBe(true);
});
