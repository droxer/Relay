import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkspaceFilePanes } from "../src/components/workspace/WorkspaceFilePanes";

vi.mock("../src/components/workspace/WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: ({ name }: { name: string }) => <div>{`Preview: ${name}`}</div>,
}));
vi.mock("../src/components/workspace/WorkspaceFileActions", () => ({
  WorkspaceFileActions: () => <div />,
}));

it("keeps the directory browser visible beside a selected file and lets the preview close", () => {
  const onClosePreview = vi.fn();
  const onSelectFile = vi.fn();
  render(<WorkspaceFilePanes
    path="" selectedPath="report.md"
    files={{ data: { scope: "shared", source: "live", nodeId: "node", path: "", generatedAt: "2026-10-01T00:00:00Z", exists: true, entries: [{ name: "report.md", path: "report.md", kind: "file", bytes: 12, updatedAt: "2026-10-01T00:00:00Z" }] }, error: null, isLoading: false }}
    content={{ data: undefined, error: null, isLoading: false }}
    view="source" setView={vi.fn()} openDirectory={vi.fn()}
    onSelectFile={onSelectFile} onRetry={vi.fn()} onClosePreview={onClosePreview}
  />);
  expect(screen.getByText("Preview: report.md")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "workspace.close_preview" }));
  expect(onClosePreview).toHaveBeenCalledOnce();
  expect(document.querySelector(".workspace-pane-browse")).toBeTruthy();
});
