import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordArtifacts } from "../src/components/task-record/RecordArtifacts";

vi.mock("../src/api", () => ({
  listTaskArtifacts: vi.fn(async () => ({ artifacts: [
    { id: "notes", title: "notes.md", kind: "workspace_file", sessionId: "s", createdAt: "2026-11-01T00:00:00Z", bytes: 100 },
    { id: "report", title: "report.md", kind: "workspace_file", sessionId: "s", createdAt: "2026-11-01T00:00:00Z", bytes: 200 },
  ] })),
}));
vi.mock("../src/components/task-record/RecordArtifactPreview", () => ({
  RecordArtifactPreview: ({ artifact, onBack }: any) => <section aria-label="Preview">
    <p>{artifact.title}</p><button onClick={onBack}>Back to files</button>
  </section>,
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><RecordArtifacts taskId="t" /></QueryClientProvider>);
}

it("returns to the selected file with keyboard focus after reading it", async () => {
  const user = userEvent.setup();
  setup();
  const report = await screen.findByRole("button", { name: /report.md/ });
  await user.click(report);
  await user.click(await screen.findByRole("button", { name: "Back to files" }));
  await waitFor(() => expect(report.getAttribute("aria-current")).toBe("true"));
  expect(document.activeElement).toBe(report);
});

it("lets arrow keys browse the list without opening the narrow preview", async () => {
  const user = userEvent.setup();
  const { container } = setup();
  const notes = await screen.findByRole("button", { name: /notes.md/ });
  notes.focus();
  await user.keyboard("{ArrowDown}");
  const report = screen.getByRole("button", { name: /report.md/ });
  expect(document.activeElement).toBe(report);
  expect(report.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector(".record-artifacts.is-reading")).toBeNull();
  await user.keyboard("{Enter}");
  expect(container.querySelector(".record-artifacts.is-reading")).not.toBeNull();
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(notes);
  expect(notes.getAttribute("aria-current")).toBe("true");
});
