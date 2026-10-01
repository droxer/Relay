import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RelayArtifact } from "relay-core";
import { ArtifactsDrawer } from "../src/components/artifact/ArtifactsDrawer";

vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => children }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));
vi.mock("../src/components/LazyMarkdown", () => ({ Markdown: ({ text }: any) => <div data-testid="markdown">{text}</div> }));
vi.mock("../src/components/CodeView", () => ({
  CodeView: ({ code }: any) => <pre data-testid="source">{code}</pre>,
  languageForFile: () => null,
}));

const bodies: Record<string, string> = {
  plan: "## Plan\n\n1. Bump axios",
  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line\n context line",
};
vi.mock("../src/lib/useArtifactBody", () => ({
  useArtifactBody: (_sessionId: string, id: string) => ({ isLoading: false, isError: false, isSuccess: true, data: bodies[id] ?? "" }),
}));

const artifacts = [
  { id: "plan", kind: "plan", title: "Upgrade plan", createdAt: "2026-10-01T10:00:00.000Z" },
  { id: "diff", kind: "diff", title: "package.json bump", createdAt: "2026-10-01T10:05:00.000Z" },
  { id: "py", kind: "workspace_file", title: "audit.py", workspaceRelativePath: "scripts/audit.py", contentType: "text/x-python", createdAt: "2026-10-01T10:10:00.000Z" },
  { id: "csv", kind: "workspace_file", title: "outdated.csv", workspaceRelativePath: "outdated.csv", contentType: "text/csv", createdAt: "2026-10-01T10:20:00.000Z" },
] as unknown as RelayArtifact[];

function stubViewport(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

function openDrawer(initialArtifactId = "plan") {
  return render(<ArtifactsDrawer open onClose={vi.fn()} artifacts={artifacts} sessionId="s" initialArtifactId={initialArtifactId} />);
}

const strip = () => screen.getByRole("navigation", { name: "artifact.strip_label" });
const searchToggle = () => within(strip()).getAllByRole("button").find((button) => button.hasAttribute("aria-expanded"))!;
const listRow = (title: string) => [...document.querySelectorAll(".artifact-index-row")]
  .find((node) => node.textContent?.includes(title)) as HTMLElement;

beforeEach(() => stubViewport(false));

it("draws a diff line's sign once, in the gutter", () => {
  const { container } = openDrawer("diff");
  const texts = [...container.querySelectorAll(".artifact-diff-text")].map((node) => node.textContent ?? "");
  expect(texts).toEqual(expect.arrayContaining(["old line", "new line", "context line"]));
  expect(texts.filter((text) => !text.startsWith("@@")).some((text) => /^[+\- ]/.test(text))).toBe(false);
});

it("offers the preview/source switch for a body with two readings", () => {
  openDrawer("plan");
  expect(screen.getByRole("group", { name: "artifact.view_mode" })).toBeTruthy();
});

it("drops the switch when the picked artifact has a single reading", () => {
  openDrawer("diff");
  expect(screen.queryByRole("group", { name: "artifact.view_mode" })).toBeNull();
});

it("opens the list only from the search button, never on hover, and closes it on Escape", () => {
  openDrawer();
  fireEvent.mouseEnter(strip());
  expect(strip().className).not.toMatch(/is-expanded/);
  fireEvent.click(searchToggle());
  expect(strip().className).toMatch(/is-expanded/);
  fireEvent.keyDown(strip(), { key: "Escape" });
  expect(strip().className).not.toMatch(/is-expanded/);
});

it("puts the overlay list away after a pick on a wide screen", () => {
  openDrawer();
  fireEvent.click(searchToggle());
  fireEvent.click(listRow("audit.py"));
  expect(strip().className).not.toMatch(/is-expanded/);
  expect(screen.getByRole("region", { name: "artifact.preview_label" }).textContent).toContain("audit.py");
});

it("keeps the in-flow list open after a pick on a narrow screen", () => {
  stubViewport(true);
  openDrawer();
  fireEvent.click(listRow("audit.py"));
  expect(strip().className).toMatch(/is-expanded/);
});

it("tags only kinds a title does not name, and stamps every row with its time", () => {
  openDrawer();
  expect(listRow("Upgrade plan").querySelector(".artifact-kind-tag")?.textContent).toBe("artifact.kind.plan");
  expect(listRow("audit.py").querySelector(".artifact-kind-tag")).toBeNull();
  expect(listRow("audit.py").querySelector(".artifact-index-row-date")?.textContent).toMatch(/Oct/);
});

it("gives produced files their family's glyph instead of one blank sheet", () => {
  openDrawer();
  const glyph = (title: string) => listRow(title).querySelector("svg")!.getAttribute("class");
  expect(glyph("audit.py")).toMatch(/file-code/);
  expect(glyph("outdated.csv")).toMatch(/file-spreadsheet/);
});

it("downloads under the sanitised title through a real link", () => {
  openDrawer("plan");
  const link = screen.getByText("artifact.action_download").closest("a")!;
  expect(link.getAttribute("download")).toBe("Upgrade plan");
  expect(link.getAttribute("href")).toMatch(/\/threads\/s\/artifacts\/plan$/);
});
