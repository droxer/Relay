import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AgentDelegationSettings } from "../src/components/AgentDelegationSettings";
import { DirectDelegationCard } from "../src/components/DirectDelegationCard";
import type { UserAgent } from "../src/types";

const agents = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../src/api", () => ({ listUserAgents: agents.list, listControlPanelAgents: agents.list }));

function agent(id: string, computerId = "computer", supervisorUserId = "alice"): UserAgent {
  return { id, displayName: id.toUpperCase(), computerId, supervisorUserId, enabled: true } as UserAgent;
}
function settings(onChange = vi.fn().mockResolvedValue(undefined), selected: string[] | null = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AgentDelegationSettings agent={{...agent("a"), delegationAgentIds: selected}}
    editable onChange={onChange} /></QueryClientProvider>);
  return onChange;
}

it("offers owned agents on the same Computer and preserves successive saves", async () => {
  agents.list.mockResolvedValue({ agents: [agent("a"), agent("b"), agent("c"), agent("other", "elsewhere"), agent("foreign", "computer", "bob")] });
  const save = settings();
  fireEvent.click(await screen.findByRole("checkbox", {name: "B"}));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(["b"]));
  await waitFor(() => expect(screen.getByRole("checkbox", {name: "B"}).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(screen.getByRole("checkbox", {name: "C"}));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(["b", "c"]));
  expect(screen.queryByRole("checkbox", {name: "A"})).toBeNull();
  expect(screen.queryByRole("checkbox", {name: "OTHER"})).toBeNull();
  expect(screen.queryByRole("checkbox", {name: "FOREIGN"})).toBeNull();
});

it("shows save failures and leaves the previous permission intact", async () => {
  agents.list.mockResolvedValue({agents: [agent("b")]});
  settings(vi.fn().mockRejectedValue(new Error("Permission update failed")));
  fireEvent.click(await screen.findByRole("checkbox", {name: "B"}));
  expect(await screen.findByText("Permission update failed")).toBeTruthy();
  expect(screen.getByRole("checkbox", {name: "B"}).getAttribute("aria-checked")).toBe("false");
});

it("lets the owner remove a target that moved or was deleted", async () => {
  agents.list.mockResolvedValue({agents: []});
  const save = settings(undefined, ["gone"]);
  fireEvent.click(await screen.findByRole("checkbox", {name: "delegation.unavailable_target"}));
  await waitFor(() => expect(save).toHaveBeenCalledWith([]));
});

it("renders an expandable receipt with attributed report and acceptance criteria", () => {
  render(<DirectDelegationCard names={{a: "Ada", b: "Ben"}} delegation={{id: "d", requestedByAgentId: "a", targetAgentId: "b",
    requesterAssignmentId: "a1", childAssignmentId: "b1", resumeAssignmentId: "a2", objective: "Write tests",
    expectedOutputs: ["test_login.py"], acceptanceCriteria: ["Expiry is covered"], status: "returned",
    child: {workResult: {status: "blocked", evidence: [], note: "Missing fixture"}} as never }} />);
  expect(screen.getByText("Write tests")).toBeTruthy();
  expect(screen.getByText("Expiry is covered")).toBeTruthy();
  expect(screen.getByText(/Missing fixture/)).toBeTruthy();
  const summary = screen.getByText("delegation.receipt").closest("summary")!;
  fireEvent.click(summary);
  expect(summary.parentElement?.getAttribute("open")).not.toBeNull();
});

it("shows returned evidence and context without treating the report as acceptance", () => {
  render(<DirectDelegationCard delegation={{id: "d", requestedByAgentId: "a", targetAgentId: "b",
    requesterAssignmentId: "a1", childAssignmentId: "b1", resumeAssignmentId: "a2", objective: "Write tests",
    context: "Use the existing fixtures", expectedOutputs: ["tests"], acceptanceCriteria: ["Tests pass"], status: "returned",
    child: {workResult: {status: "done", evidence: ["pytest: 8 passed"]}} as never }} />);
  expect(screen.getByText("pytest: 8 passed")).toBeTruthy();
  expect(screen.getByText("Use the existing fixtures")).toBeTruthy();
  expect(screen.getByText("delegation.accountability")).toBeTruthy();
});

it("shows runtime failures when there is no returned report", () => {
  render(<DirectDelegationCard delegation={{id: "d", requestedByAgentId: "a", targetAgentId: "b",
    requesterAssignmentId: "a1", childAssignmentId: "b1", resumeAssignmentId: "a2", objective: "Write tests",
    expectedOutputs: [], acceptanceCriteria: [], status: "returned", child: {status: "failed"} as never }} />);
  expect(screen.getByText("delegation.runtime_failed")).toBeTruthy();
});

it("shows queued work before any delegate has started", () => {
  render(<DirectDelegationCard delegation={{id: "d", requestedByAgentId: "a", targetAgentId: "b",
    requesterAssignmentId: "a1", childAssignmentId: "b1", resumeAssignmentId: "a2", objective: "Write tests",
    expectedOutputs: [], acceptanceCriteria: [], status: "queued"}} />);
  expect(screen.getByText("delegation.status.queued")).toBeTruthy();
  expect(screen.queryByText("delegation.runtime_failed")).toBeNull();
});

it("shows an actionable empty state when no eligible agent exists", async () => {
  agents.list.mockResolvedValue({agents: []});
  settings();
  expect(await screen.findByText("delegation.no_targets")).toBeTruthy();
});

it("keeps roster failures visible without claiming that no agents exist", async () => {
  agents.list.mockRejectedValue(new Error("Network unavailable"));
  settings();
  expect(await screen.findByText("delegation.load_failed")).toBeTruthy();
  expect(screen.queryByText("delegation.no_targets")).toBeNull();
});

it("shows loading while the roster request is pending", () => {
  agents.list.mockReturnValue(new Promise(() => {}));
  settings();
  expect(screen.getByRole("status").textContent).toBe("delegation.loading");
});

it("uses the administrator roster for the agent's owner", async () => {
  agents.list.mockResolvedValue({agents: [agent("b")]});
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AgentDelegationSettings agent={agent("a")} editable admin onChange={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByRole("checkbox", {name: "B"})).toBeTruthy();
  expect(agents.list).toHaveBeenLastCalledWith("alice", expect.any(AbortSignal));
});

it("does not offer edit controls to a read-only viewer with no grants", () => {
  const client = new QueryClient();
  const {container} = render(<QueryClientProvider client={client}><AgentDelegationSettings agent={{...agent("a"), delegationAgentIds: []}} editable={false} onChange={vi.fn()} /></QueryClientProvider>);
  expect(container.querySelector("fieldset")).toBeNull();
});

it("permits all eligible agents by default without saving a fixed list", async () => {
  agents.list.mockResolvedValue({agents: [agent("b"), agent("c")]});
  const client = new QueryClient();
  const save = vi.fn();
  render(<QueryClientProvider client={client}><AgentDelegationSettings agent={agent("a")} editable onChange={save} /></QueryClientProvider>);
  const all = screen.getByRole("checkbox", {name: "delegation.all_eligible"});
  expect(all.getAttribute("aria-checked")).toBe("true");
  expect((await screen.findByRole("checkbox", {name: "B"})).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("checkbox", {name: "C"}).getAttribute("aria-checked")).toBe("true");
  expect(save).not.toHaveBeenCalled();
});

it("switches between all eligible agents and an explicit custom list", async () => {
  agents.list.mockResolvedValue({agents: [agent("b")]});
  const save = settings(undefined, null);
  const all = screen.getByRole("checkbox", {name: "delegation.all_eligible"});
  fireEvent.click(all);
  await waitFor(() => expect(save).toHaveBeenLastCalledWith([]));
  const target = await screen.findByRole("checkbox", {name: "B"});
  await waitFor(() => expect(target.getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(target);
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(["b"]));
  await waitFor(() => expect(target.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(all);
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null));
});
