import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import type { ProjectRecord } from "../src/types";

const { confirm, remove } = vi.hoisted(() => ({ confirm: vi.fn(), remove: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => key.split(".").reduce<any>((value, part) => value?.[part], en) ?? key,
}) }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => vi.fn().mockResolvedValue(true) }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  createProjectMutation: { isPending: false }, updateProjectMutation: { isPending: false },
  archiveProjectMutation: { isPending: false }, deleteProjectMutation: { isPending: false, mutateAsync: remove },
}) }));
const project = { id: "p", name: "Launch", computerId: "c", version: 3, members: [], enabled: true } as unknown as ProjectRecord;
beforeEach(() => { confirm.mockReset(); remove.mockReset(); });

it("does not delete when the user cancels the destructive confirmation", async () => {
  confirm.mockResolvedValue(false);
  render(<ProjectDrawer open project={project} computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm.mock.calls[0][0].message).toMatch(/tasks, routines, conversations, and artifacts/);
  expect(remove).not.toHaveBeenCalled();
});

it("deletes the current version and leaves the project after confirmation", async () => {
  confirm.mockResolvedValue(true);
  remove.mockResolvedValue({ deletedProjectId: "p", workspaceCleanup: "queued" });
  const onDeleted = vi.fn(); const onClose = vi.fn(); const onSaved = vi.fn();
  render(<ProjectDrawer open project={project} computers={[]} onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 3 });
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
});

it("keeps settings open when deletion fails and allows deleting archived projects", async () => {
  confirm.mockResolvedValue(true);
  remove.mockRejectedValue(new Error("project_execution_active"));
  const onClose = vi.fn(); const onDeleted = vi.fn();
  render(<ProjectDrawer open project={{ ...project, archivedAt: "2026-09-01" }} computers={[]} onClose={onClose} onSaved={vi.fn()} onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(onClose).not.toHaveBeenCalled();
  expect(onDeleted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Archive project" }).hasAttribute("disabled")).toBe(true);
});
