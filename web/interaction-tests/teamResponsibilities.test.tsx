import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TeamMemberPicker, addTeamMember, removeTeamMember, type TeamMembership } from "../src/components/TeamMemberPicker";
import { TeamMemberCard } from "../src/components/TeamMemberCard";
import { CollaborationWork } from "../src/components/CollaborationWork";
import { teamMutationInput } from "../src/lib/teamForm";
import type { EmployeeAgent, RelaySession, TeamMemberConfig } from "../src/types";

const agent = (id: string, displayName: string, executorKind: EmployeeAgent["executorKind"] = "codex") => ({
  id, displayName, executorKind, enabled: true, availability: "ready", placements: [], deletedAt: null,
}) as unknown as EmployeeAgent;

const ROSTER = [agent("lead", "Planner", "claude"), agent("builder", "Builder"), agent("qa", "Checker")];

function PickerHarness({ initial }: { initial: TeamMembership }) {
  const [value, setValue] = useState(initial);
  return <>
    <TeamMemberPicker agents={ROSTER} value={value} onChange={setValue} />
    <output data-testid="membership">{JSON.stringify(value)}</output>
  </>;
}

const membership = () => JSON.parse(screen.getByTestId("membership").textContent!);

it("shows old completed snapshots as unverified without inventing acceptance", () => {
  const session = { status: "completed", agentRuns: [] } as unknown as RelaySession;
  render(<CollaborationWork session={session} agents={[]} />);
  expect(screen.getByRole("status").textContent).toContain("team_work.outcome_unverified");
});

it.each(["reported_done", "unfinished", "blocked", "needs_review", "unverified", "accepted"] as const)(
  "shows %s work outcome even when a single agent has no team graph", (workOutcome) => {
    const session = { status: "completed", workOutcome, finalOutcome: "A concrete next step", agentRuns: [] } as unknown as RelaySession;
    const { rerender } = render(<CollaborationWork session={session} agents={[]} />);
    expect(screen.getByRole("status").textContent).toContain(`team_work.outcome_${workOutcome}`);
    expect(screen.getByText("A concrete next step")).toBeTruthy();
    const running = { ...session, status: "running" as const, workOutcome: undefined };
    rerender(<CollaborationWork session={running} agents={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
  },
);

it("lists only the team's members, with the lead marked on its own row", () => {
  render(<PickerHarness initial={{ memberIds: ["lead", "builder"], leadId: "lead" }} />);
  const rows = document.querySelectorAll(".team-member-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Planner");
  expect(rows[0].textContent).toContain("project.lead_badge");
  expect(rows[1].textContent).not.toContain("project.lead_badge");
  // Checker is not on the team, so it is not drawn as a row.
  expect(screen.queryByText("Checker")).toBeNull();
  expect(screen.getByLabelText("teams.add_member")).toBeTruthy();
});

it("moves the lead from the row and hands it on when the lead is removed", () => {
  render(<PickerHarness initial={{ memberIds: ["lead", "builder"], leadId: "lead" }} />);
  fireEvent.click(screen.getByRole("button", { name: "teams.make_lead_named" }));
  expect(membership()).toEqual({ memberIds: ["lead", "builder"], leadId: "builder" });
  const removeBuilder = document.querySelectorAll<HTMLButtonElement>(".team-member-row-remove")[1];
  fireEvent.click(removeBuilder);
  expect(membership()).toEqual({ memberIds: ["lead"], leadId: "lead" });
});

it("makes the first added member the lead", () => {
  expect(addTeamMember({ memberIds: [], leadId: "" }, "qa")).toEqual({ memberIds: ["qa"], leadId: "qa" });
  expect(addTeamMember({ memberIds: ["qa"], leadId: "qa" }, "builder")).toEqual({ memberIds: ["qa", "builder"], leadId: "qa" });
  expect(removeTeamMember({ memberIds: ["qa"], leadId: "qa" }, "qa")).toEqual({ memberIds: [], leadId: "" });
});

it("makes on-request participation optional in the saved payload", async () => {
  const saved: TeamMemberConfig[] = [];
  render(
    <TeamMemberCard
      member={{ id: "builder", displayName: "Builder", executorKind: "codex" }}
      config={{}}
      lead={false}
      canEdit
      onSave={async (next) => { saved.push(next); return true; }}
    />,
  );
  fireEvent.click(document.querySelector<HTMLButtonElement>(".team-work-member-edit")!);
  expect(screen.getByRole("checkbox", { name: "team_work.required" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.change(screen.getByLabelText("team_work.responsibility"), { target: { value: "Own the reset API" } });
  // <Checkbox> is the base-ui primitive: a role=checkbox element plus a
  // visually hidden native input, so the control is addressed by role, and
  // disablement reads off the primitive's own state attribute.
  fireEvent.click(screen.getByRole("checkbox", { name: "team_work.on_request" }));
  expect(screen.getByRole("checkbox", { name: "team_work.required" })
    .hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "team_work.save_member" }));
  await screen.findByText("Own the reset API");
  const payload = teamMutationInput({
    name: "Team", leadAgentId: "lead", memberAgentIds: ["lead", "builder"], enabled: true,
    memberConfigs: { builder: saved[0] }, acceptanceCriteria: ["No reusable reset token", ""],
  });
  expect(payload.memberConfigs?.builder).toEqual({ responsibility: "Own the reset API", participation: "on_request", required: false });
  expect(payload.acceptanceCriteria).toEqual(["No reusable reset token"]);
});

// The setup's Button mock drops `tooltip` (the real one turns it into the
// aria-label), so the icon-only pencil is addressed by its class.
const pencil = () => document.querySelector<HTMLButtonElement>(".team-work-member-edit")!;

it("reads as a summary and edits one member in place", async () => {
  const saved: TeamMemberConfig[] = [];
  render(
    <TeamMemberCard
      member={{ id: "qa", displayName: "Checker", executorKind: "codex", defaultRole: "reviewer", availability: "ready" }}
      config={{ responsibility: "Review the diff", expectedOutputs: ["Findings list"] }}
      lead={false}
      canEdit
      onSave={async (next) => { saved.push(next); return true; }}
    />,
  );
  // Read mode: the summary, no form controls.
  expect(screen.getByText("Review the diff")).toBeTruthy();
  expect(screen.getByText("Findings list")).toBeTruthy();
  // A reviewer is required by default.
  expect(screen.getByText("team_work.required")).toBeTruthy();
  expect(screen.queryByLabelText("team_work.responsibility")).toBeNull();

  fireEvent.click(pencil());
  fireEvent.change(screen.getByLabelText("team_work.responsibility"), { target: { value: "Review auth changes" } });
  fireEvent.click(screen.getByRole("button", { name: "team_work.save_member" }));
  await screen.findByText("Review auth changes");
  expect(saved).toEqual([{ responsibility: "Review auth changes", expectedOutputs: ["Findings list"] }]);
  expect(screen.queryByLabelText("team_work.responsibility")).toBeNull();
});

it("discards the draft on cancel and stays open when the save fails", async () => {
  render(
    <TeamMemberCard
      member={{ id: "b", displayName: "Builder", executorKind: "claude" }}
      config={{}}
      lead
      canEdit
      onSave={async () => false}
    />,
  );
  expect(screen.getByText("team_work.no_responsibility")).toBeTruthy();
  fireEvent.click(pencil());
  // The lead has no participation flags.
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("team_work.responsibility"), { target: { value: "Plan" } });
  fireEvent.click(screen.getByRole("button", { name: "team_work.save_member" }));
  await Promise.resolve();
  expect((screen.getByLabelText("team_work.responsibility") as HTMLTextAreaElement).value).toBe("Plan");
  fireEvent.click(screen.getByRole("button", { name: "dialog.cancel" }));
  expect(screen.queryByLabelText("team_work.responsibility")).toBeNull();
  expect(screen.getByText("team_work.no_responsibility")).toBeTruthy();
});

it("locks the pencil while another card is open", () => {
  render(
    <TeamMemberCard
      member={{ id: "b", displayName: "Builder", executorKind: "claude" }}
      config={{}}
      lead={false}
      canEdit={false}
      onSave={async () => true}
    />,
  );
  expect(pencil().disabled).toBe(true);
});

it("shows acceptance evidence and attributed review findings without claiming acceptance", () => {
  const session = {
    collaborationRounds: [{ roundId: "r", workGraph: { items: [{ workItemId: "review", assignmentId: "review", ownerAgentId: "reviewer", objective: "Review token handling", required: true, dependsOnWorkItemIds: [] }] } }],
    agentRuns: [{ id: "run", assignmentId: "review", status: "completed", workResult: { status: "continue", evidence: ["Reused token returned 200"], findings: [{ workItemId: "api", note: "Reject used tokens" }] } }],
  } as unknown as RelaySession;
  render(<CollaborationWork session={session} agents={[]} />);
  expect(screen.getByText("team_work.status_needs_changes")).toBeTruthy();
  expect(screen.getByText("Reused token returned 200")).toBeTruthy();
  // A finding renders with the message grammar: bold kind, the work item it
  // targets, then the note.
  expect(screen.getByText(/→ api: Reject used tokens/)).toBeTruthy();
  expect(screen.getByText("team_work.finding")).toBeTruthy();
  expect(screen.queryByText("team_work.status_accepted")).toBeNull();
});

it("distinguishes reported work, missing evidence, failures and stale downstream reviews", () => {
  const item = (id: string, extra = {}) => ({ workItemId: id, assignmentId: id, ownerAgentId: "builder", objective: id, required: true, dependsOnWorkItemIds: [], ...extra });
  const session = {
    collaborationRounds: [{ workGraph: { items: [
      item("build", { acceptanceCriteria: ["Handles empty input"], expectedOutputs: ["Regression test"] }),
      item("review", { dependsOnWorkItemIds: ["build"] }),
      item("pending", { required: false }), item("missing"), item("failed"), item("blocked"),
    ] } }],
    agentRuns: [
      { id: "review", assignmentId: "review", status: "completed", workResult: { status: "done", evidence: ["Old review"] } },
      { id: "build", assignmentId: "build", status: "completed", workResult: {
        status: "done", evidence: ["Regression passed"], note: "Fixed empty input", messages: [
          { kind: "handoff", toWorkItemId: "review", text: "Please revalidate" },
          { kind: "decision", text: "Keep the public API" },
        ],
      } },
      { id: "answer", assignmentId: "build", consultation: true, status: "completed", workResult: { status: "done", evidence: ["Answered"] } },
      { id: "missing", assignmentId: "missing", status: "completed" },
      { id: "failed", assignmentId: "failed", status: "failed" },
      { id: "blocked", assignmentId: "blocked", status: "completed", workResult: { status: "blocked", evidence: [] } },
    ],
  } as unknown as RelaySession;
  const { rerender } = render(<CollaborationWork session={session} agents={ROSTER} />);
  expect(screen.getByText("team_work.status_reported_done")).toBeTruthy();
  expect(screen.queryByText("team_work.status_accepted")).toBeNull();
  expect(screen.getByText("team_work.status_stale")).toBeTruthy();
  expect(screen.getByText("team_work.status_pending")).toBeTruthy();
  expect(screen.getByText("team_work.status_unverified")).toBeTruthy();
  expect(screen.getAllByText("team_work.status_blocked")).toHaveLength(2);
  expect(screen.getByText("Fixed empty input")).toBeTruthy();
  expect(screen.getByText(/Handles empty input/)).toBeTruthy();
  expect(screen.getByText(/Regression test/)).toBeTruthy();
  expect(screen.getByText(/→ review: Please revalidate/)).toBeTruthy();
  expect(screen.getByText(/Keep the public API/)).toBeTruthy();
  const running = { ...session, agentRuns: [{ id: "now", assignmentId: "build", status: "running" }] } as RelaySession;
  rerender(<CollaborationWork session={running} agents={ROSTER} />);
  expect(screen.getByText("team_work.status_running")).toBeTruthy();
});
