import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { ProjectAskAgentSection, ProjectContextSuggestions } from "../src/components/ProjectContextUpkeep";
import type { ProjectRecord } from "../src/types";

const { update, getProject, startSetup } = vi.hoisted(() => ({ update: vi.fn(), getProject: vi.fn(), startSetup: vi.fn() }));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  startProjectSetupMutation: { isPending: false, mutateAsync: startSetup },
}) }));

const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const suggestion = { id: "r:0", text: "Pricing lives in content/pricing.json.", evidence: "Created it", threadId: "t", runId: "r" };
const withSuggestions = { ...project, context: "Use Next.js.", contextSuggestions: [suggestion, { ...suggestion, id: "r:1", text: "Noise" }] };
const conflict = () => new RelayApiError("project_version_conflict", 409, "project_version_conflict");

beforeEach(() => {
  update.mockReset().mockResolvedValue({ project });
  getProject.mockReset();
  startSetup.mockReset();
});

it("adopts a suggestion at once: appends it to the context and resolves it in one revision", async () => {
  render(<ProjectContextSuggestions project={withSuggestions} readOnly={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_adopt" })[0]);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][0]).toEqual({ projectId: "p", input: {
    expectedVersion: 1,
    resolveContextSuggestions: ["r:0"],
    context: "Use Next.js.\n- Pricing lives in content/pricing.json.",
  } });
});

it("dismisses a suggestion without touching the context", async () => {
  render(<ProjectContextSuggestions project={withSuggestions} readOnly={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_dismiss" })[1]);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][0].input).toEqual({ expectedVersion: 1, resolveContextSuggestions: ["r:1"] });
});

it("re-appends onto the latest context after a concurrent edit", async () => {
  update.mockRejectedValueOnce(conflict());
  getProject.mockResolvedValue({ project: { ...withSuggestions, context: "Use Remix.", version: 4 } });
  render(<ProjectContextSuggestions project={withSuggestions} readOnly={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_adopt" })[0]);
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1][0].input).toEqual({
    expectedVersion: 4,
    resolveContextSuggestions: ["r:0"],
    context: "Use Remix.\n- Pricing lives in content/pricing.json.",
  });
});

it("does not retry a suggestion someone else already settled", async () => {
  update.mockRejectedValueOnce(conflict());
  getProject.mockResolvedValue({ project: { ...withSuggestions, contextSuggestions: [], version: 2 } });
  render(<ProjectContextSuggestions project={withSuggestions} readOnly={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_adopt" })[0]);
  await waitFor(() => expect(getProject).toHaveBeenCalled());
  expect(update).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says so when the retry conflicts again", async () => {
  update.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
  getProject.mockResolvedValue({ project: { ...withSuggestions, version: 2 } });
  render(<ProjectContextSuggestions project={withSuggestions} readOnly={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_adopt" })[0]);
  expect((await screen.findByRole("alert")).textContent).toBe("project.context_suggestion_conflict");
});

it("shows a read-only project's suggestions without decisions, and opens their thread", () => {
  const onOpenThread = vi.fn();
  render(<ProjectContextSuggestions project={withSuggestions} readOnly onOpenThread={onOpenThread} />);
  expect(screen.getByText(suggestion.text)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "project.context_suggestion_adopt" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_source" })[0]);
  expect(onOpenThread).toHaveBeenCalledWith("t");
});

it("renders nothing when no suggestion is pending", () => {
  const { container } = render(<ProjectContextSuggestions project={project} readOnly={false} />);
  expect(container.innerHTML).toBe("");
});

it("asks the crew for a refine proposal", async () => {
  startSetup.mockResolvedValue({ project, threadId: "t" });
  const onStarted = vi.fn();
  render(<ProjectAskAgentSection project={project} onStarted={onStarted} />);
  // Plan and refine share one section; refine is the second choice.
  fireEvent.click(screen.getByRole("radio", { name: "project.refine_title" }));
  fireEvent.change(screen.getByRole("textbox", { name: "project.refine_note" }), { target: { value: "Too many bugs slip through" } });
  fireEvent.click(screen.getByRole("button", { name: "project.refine_start" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Too many bugs slip through" } });
});

it("holds off a refine while a setup draft is open", () => {
  render(<ProjectAskAgentSection project={{ ...project, setup: { state: "proposed", intent: "x", agentId: "a", threadId: "t", startedAt: "s" } } as ProjectRecord} />);
  expect(screen.getByText("project.refine_open")).toBeTruthy();
  expect((screen.getByRole("button", { name: "project.plan_start" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "project.refine_title" }));
  expect((screen.getByRole("button", { name: "project.refine_start" }) as HTMLButtonElement).disabled).toBe(true);
});

it("asks the lead for a plan once the project has a crew", async () => {
  startSetup.mockResolvedValue({ project, threadId: "t" });
  render(<ProjectAskAgentSection project={{ ...project, leadAgentId: "a" } as ProjectRecord} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.plan_note" }), { target: { value: "Plan the launch" } });
  fireEvent.click(screen.getByRole("button", { name: "project.plan_start" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Plan the launch", mode: "plan" } }));
});

it("holds off a plan until the project has a lead", () => {
  render(<ProjectAskAgentSection project={project} />);
  expect(screen.getByText("project.plan_needs_crew")).toBeTruthy();
  expect((screen.getByRole("button", { name: "project.plan_start" }) as HTMLButtonElement).disabled).toBe(true);
});
