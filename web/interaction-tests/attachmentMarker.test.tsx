import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RelayArtifact } from "relay-core";
import { AttachmentMarker } from "../src/components/AttachmentMarker";
import { MessageBlock } from "../src/components/MessageBlock";
import { DialogProvider } from "@/components/ui/DialogProvider";

const open = vi.fn();
vi.mock("../src/components/ArtifactViewerProvider", () => ({ useArtifactViewer: () => ({ open }) }));

const file = (id: string, title: string) =>
  ({ id, kind: "workspace_file", title, createdAt: "2026-10-02T10:00:00.000Z" }) as unknown as RelayArtifact;
const report = file("a", "report.md");
const data = file("b", "data.csv");

it("renders nothing when a turn produced no files", () => {
  const { container } = render(<AttachmentMarker artifacts={[]} sessionId="s" />);
  expect(container.firstChild).toBeNull();
});

it("names a single file and opens it in the files panel", () => {
  const onOpenArtifact = vi.fn();
  render(<AttachmentMarker artifacts={[report]} sessionId="s" onOpenArtifact={onOpenArtifact} />);

  fireEvent.click(screen.getByRole("button"));

  expect(screen.getByText("report.md")).toBeTruthy();
  expect(onOpenArtifact).toHaveBeenCalledWith(report);
});

it("collapses several files into one count and opens the first", () => {
  const onOpenArtifact = vi.fn();
  render(<AttachmentMarker artifacts={[report, data]} sessionId="s" onOpenArtifact={onOpenArtifact} />);

  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.getByText("artifact.inline_files")).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  expect(onOpenArtifact).toHaveBeenCalledWith(report);
});

it("falls back to the artifact viewer when no panel handler is wired", () => {
  render(<AttachmentMarker artifacts={[report, data]} sessionId="s" />);

  fireEvent.click(screen.getByRole("button"));

  expect(open).toHaveBeenCalledWith(report, "s", [report, data]);
});

it("shows one marker after an agent turn instead of a chip per file", () => {
  const message = { kind: "agent", id: "m", timestamp: "2026-10-02", agent: "codex", runId: "r", streaming: false, stdout: "", stderr: "", collaborations: [], attachments: [report, data] };
  const { container } = render(<DialogProvider><MessageBlock message={message as never} sessionId="s" /></DialogProvider>);

  expect(container.querySelectorAll(".attachment-marker")).toHaveLength(1);
  expect(container.querySelectorAll(".artifact-chip")).toHaveLength(0);
});
