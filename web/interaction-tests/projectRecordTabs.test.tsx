import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskRecordPage } from "../src/components/task-record/TaskRecordPage";
import { canonicalBrowserUrl } from "../src/lib/appRoute";
import type { RelayTaskListItem } from "../src/types";

vi.mock("../src/hooks/useProjectLookup", () => ({ useProjectLookup: () => () => undefined }));
vi.mock("../src/hooks/useEmployeeNames", () => ({ useEmployeeNames: () => new Map() }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/components/task-record/RecordHistory", () => ({ RecordHistory: () => null }));
vi.mock("../src/components/task-record/RecordResultLine", () => ({ RecordResultLine: () => null }));
vi.mock("../src/components/task-record/RecordArtifacts", () => ({ RecordArtifacts: () => null }));
vi.mock("../src/components/task-record/RecordWorkspace", () => ({ RecordWorkspace: () => null }));
vi.mock("../src/components/ExecutionRecoveryPanel", () => ({ TaskRecoveryPanel: () => null }));
vi.mock("../src/components/task-record/TaskRecordActions", () => ({ TaskRecordActions: () => null }));
vi.mock("../src/components/task-record/TaskRecordDefinition", () => ({ TaskRecordDefinition: () => null }));

it("changes a project record tab without changing the project tab or closing the record", async () => {
  window.history.replaceState({}, "", "/projects/p?task=t");
  render(<TaskRecordPage
    task={{ id: "t", title: "Task", status: "backlog", priority: "normal", createdAt: "2026-09-01", updatedAt: "2026-09-01" } as RelayTaskListItem}
    currentUser={{ id: "u-1", username: "fei", role: "user", employeeId: "fei" }}
    runningRoutineIds={new Set()} busyAction={null} presentation="drawer" tabSearchKey="recordTab"
    onOpenThread={vi.fn()} onOpenRun={vi.fn()} onRun={vi.fn()} onCancel={vi.fn()}
    onToggleBlock={vi.fn()} onDone={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
  />);
  fireEvent.click(screen.getByRole("tab", { name: "record.tab_definition" }));
  await waitFor(() => expect(window.location.search).toBe("?task=t&recordTab=definition"));
  fireEvent.click(screen.getByRole("tab", { name: "record.tab_files" }));
  await waitFor(() => expect(window.location.search).toBe("?task=t&recordTab=files"));
  fireEvent.click(screen.getByRole("tab", { name: "record.tab_activity" }));
  await waitFor(() => expect(window.location.search).toBe("?task=t"));
});

it("drops drawer tabs when the project record is absent or the tab is invalid", () => {
  expect(canonicalBrowserUrl("/projects/p", "?recordTab=files")).toBe("/projects/p");
  expect(canonicalBrowserUrl("/projects/p", "?tab=general&task=t&recordTab=files")).toBe("/projects/p");
  expect(canonicalBrowserUrl("/projects/p", "?task=t&recordTab=invalid")).toBe("/projects/p?task=t");
});
