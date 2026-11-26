import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { TeamMemberPicker, addTeamMember, removeTeamMember, type TeamMembership } from "../src/components/TeamMemberPicker";
import { TeamMemberCard } from "../src/components/TeamMemberCard";
import type { UserAgent, RelaySession, TeamMemberConfigPatch } from "../src/types";

const agent = (id: string, displayName: string, executorKind: UserAgent["executorKind"] = "codex") => ({
  id, displayName, executorKind, enabled: true, availability: "ready", placements: [], deletedAt: null,
}) as unknown as UserAgent;

const ROSTER = [agent("lead", "Planner", "claude"), agent("builder", "Builder"), agent("qa", "Checker")];

function PickerHarness({ initial }: { initial: TeamMembership }) {
  const [value, setValue] = useState(initial);
  return <>
    <TeamMemberPicker agents={ROSTER} value={value} onChange={setValue} />
    <output data-testid="membership">{JSON.stringify(value)}</output>
  </>;
}

const membership = () => JSON.parse(screen.getByTestId("membership").textContent!);

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

it("shows the member's configured role and level in the picker", () => {
  render(<TeamMemberPicker
    agents={ROSTER}
    memberConfigs={{ lead: { role: "reviewer", roleLevel: "senior" } }}
    value={{ memberIds: ["lead"], leadId: "lead" }}
    onChange={() => {}}
  />);
  expect(screen.getByText("role_levels.senior · admin.v2.agent_role.reviewer")).toBeTruthy();
  expect(screen.queryByText("Claude")).toBeNull();
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
  const saved: TeamMemberConfigPatch[] = [];
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
  await waitFor(() => {
    expect(saved).toEqual([{ responsibility: "Own the reset API", participation: "on_request", required: false }]);
    expect(screen.queryByLabelText("team_work.responsibility")).toBeNull();
  });
});

// The setup's Button mock drops `tooltip` (the real one turns it into the
// aria-label), so the icon-only pencil is addressed by its class.
const pencil = () => document.querySelector<HTMLButtonElement>(".team-work-member-edit")!;

it("reads as a summary and edits one member in place", async () => {
  const saved: TeamMemberConfigPatch[] = [];
  const card = (expectedOutputs: string[]) => (
    <TeamMemberCard member={{ id: "qa", displayName: "Checker", executorKind: "codex", defaultRole: "reviewer", roleLevel: "senior", availability: "ready" }}
      config={{ responsibility: "Review the diff", expectedOutputs }} lead={false} canEdit
      onSave={async (fields) => { saved.push(fields); return true; }} />
  );
  const view = render(card(["Findings list"]));
  // Read mode: the summary, no form controls.
  expect(screen.getByText("role_levels.senior · admin.v2.agent_role.reviewer")).toBeTruthy();
  expect(screen.getByText("Review the diff")).toBeTruthy();
  expect(screen.getByText("Findings list")).toBeTruthy();
  // A reviewer is required by default.
  expect(screen.getByText("team_work.required")).toBeTruthy();
  expect(screen.queryByLabelText("team_work.responsibility")).toBeNull();

  fireEvent.click(pencil());
  // The role select opens on the agent's own role; there is no inherit choice.
  expect(screen.getByRole("combobox", { name: "team_work.role" }).textContent).toContain("team_work.role_reviewer");
  fireEvent.change(screen.getByLabelText("team_work.responsibility"), { target: { value: "Review auth changes" } });
  view.rerender(card(["Concurrent outputs"]));
  fireEvent.click(screen.getByRole("button", { name: "team_work.save_member" }));
  await waitFor(() => expect(screen.queryByLabelText("team_work.responsibility")).toBeNull());
  expect(saved).toEqual([{ responsibility: "Review auth changes" }]);
  expect(screen.getByText("Concurrent outputs")).toBeTruthy();
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
