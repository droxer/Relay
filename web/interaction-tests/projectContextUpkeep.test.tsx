import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { ProjectContextSuggestions } from "../src/components/ProjectContextUpkeep";
import type { ProjectRecord } from "../src/types";

const { update, getProject } = vi.hoisted(() => ({ update: vi.fn(), getProject: vi.fn() }));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
}) }));

const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const suggestion = { id: "r:0", text: "Pricing lives in content/pricing.json.", evidence: "Created it", threadId: "t", runId: "r" };
const withSuggestions = { ...project, context: "Use Next.js.", contextSuggestions: [suggestion, { ...suggestion, id: "r:1", text: "Noise" }] };
const conflict = () => new RelayApiError("project_version_conflict", 409, "project_version_conflict");

beforeEach(() => {
  update.mockReset().mockResolvedValue({ project });
  getProject.mockReset();
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
