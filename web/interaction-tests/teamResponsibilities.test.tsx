import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TeamResponsibilities } from "../src/components/TeamResponsibilities";
import { CollaborationWork } from "../src/components/CollaborationWork";
import { teamMutationInput } from "../src/lib/teamForm";
import type { RelaySession, TeamMemberConfig } from "../src/types";

it("edits responsibilities and makes on-request participation optional in the saved payload", () => {
  function Editor() {
    const [configs, setConfigs] = useState<Record<string, TeamMemberConfig>>({});
    const [criteria, setCriteria] = useState<string[]>([]);
    return <>
      <TeamResponsibilities members={[{ id: "builder", displayName: "Builder" }]} leadId="lead"
        configs={configs} criteria={criteria} onConfigs={setConfigs} onCriteria={setCriteria} />
      <output data-testid="payload">{JSON.stringify(teamMutationInput({ name: "Team", leadAgentId: "lead", memberAgentIds: ["lead", "builder"], enabled: true, memberConfigs: configs, acceptanceCriteria: criteria }))}</output>
    </>;
  }
  render(<Editor />);
  fireEvent.change(screen.getByLabelText("team_work.responsibility"), { target: { value: "Own the reset API" } });
  fireEvent.change(screen.getByLabelText(/team_work\.criteria/), { target: { value: "No reusable reset token\n" } });
  // <Checkbox> is the base-ui primitive: a role=checkbox element plus a
  // visually hidden native input, so the control is addressed by role, and
  // disablement reads off the primitive's own state attribute.
  fireEvent.click(screen.getByRole("checkbox", { name: "team_work.on_request" }));
  expect(screen.getByRole("checkbox", { name: "team_work.required" })
    .hasAttribute("data-disabled")).toBe(true);
  const payload = JSON.parse(screen.getByTestId("payload").textContent!);
  expect(payload.memberConfigs.builder).toEqual({ responsibility: "Own the reset API", participation: "on_request", required: false });
  expect(payload.acceptanceCriteria).toEqual(["No reusable reset token"]);
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
