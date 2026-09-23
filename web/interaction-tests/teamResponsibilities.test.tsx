import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TeamResponsibilities } from "../src/components/TeamResponsibilities";
import { TeamMemberCard } from "../src/components/TeamMemberCard";
import { CollaborationWork } from "../src/components/CollaborationWork";
import { teamMutationInput } from "../src/lib/teamForm";
import type { RelaySession, TeamMemberConfig } from "../src/types";

it("edits responsibilities and makes on-request participation optional in the saved payload", () => {
  function Editor() {
    const [configs, setConfigs] = useState<Record<string, TeamMemberConfig>>({});
    const [criteria, setCriteria] = useState<string[]>([]);
    return <>
      <TeamResponsibilities members={[{ id: "builder", displayName: "Builder", executorKind: "codex" }]} leadId="lead"
        configs={configs} criteria={criteria} onConfigs={setConfigs} onCriteria={setCriteria} />
      <output data-testid="payload">{JSON.stringify(teamMutationInput({ name: "Team", leadAgentId: "lead", memberAgentIds: ["lead", "builder"], enabled: true, memberConfigs: configs, acceptanceCriteria: criteria }))}</output>
    </>;
  }
  render(<Editor />);
  expect(screen.getByRole("checkbox", { name: "team_work.required" }).getAttribute("aria-checked")).toBe("true");
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

it("renders each member as an identity card with the lead pill and effective role", () => {
  render(
    <TeamResponsibilities
      members={[
        { id: "lead", displayName: "Planner", executorKind: "claude", availability: "ready" },
        { id: "qa", displayName: "Checker", executorKind: "codex", defaultRole: "reviewer", availability: "ready" },
      ]}
      leadId="lead"
      configs={{}}
      criteria={[]}
      onConfigs={() => {}}
      onCriteria={() => {}}
    />,
  );
  const cards = screen.getAllByRole("group").filter((node) => node.tagName === "ARTICLE");
  expect(cards).toHaveLength(2);
  expect(cards[0].querySelector(".team-work-member-head .agent-state")).toBeTruthy();
  expect(cards[0].textContent).toContain("project.lead_badge");
  expect(cards[1].textContent).not.toContain("project.lead_badge");
  // The inherited default role shows beside the name without opening the select.
  expect(cards[1].querySelector(".team-work-member-name")?.textContent).toContain("team_work.role_reviewer");
  expect(cards[1].querySelector(".team-work-member-identity .agent-meta")?.textContent).toContain("Codex");
  // The lead has no participation flags; everyone else does.
  expect(cards[0].querySelector(".team-work-flags")).toBeNull();
  expect(cards[1].querySelector(".team-work-flags")).toBeTruthy();
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
