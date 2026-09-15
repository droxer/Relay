import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "skills.publish_first": "Publish your first skill", "skills.publish_title": "Publish a skill", "skills.close": "Close", "skills.author": "Author", "skills.upload_bundle": "Upload bundle", "skills.github": "GitHub", "skills.skill_name": "Skill name", "skills.namespace": "Namespace", "skills.description": "Description", "skills.instructions": "Instructions", "skills.publish": "Publish", "skills.cancel": "Cancel", "skills.required": "required", "skills.optional": "optional" }[key] ?? key), i18n: { language: "en" } }) }));

const { createSkill } = vi.hoisted(() => ({ createSkill: vi.fn(async (input: any) => ({ id: "new-skill", ...input })) }));
vi.mock("../src/api", () => ({ createSkill, importSkill: vi.fn(), deleteSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn() }));
vi.mock("../src/hooks/useSkills", () => ({ SKILLS_QUERY_KEY: "skills", useSkills: () => ({ data: { skills: [] }, isLoading: false, error: null, refetch: vi.fn() }), useSkill: () => ({ data: null, isLoading: false, error: null }) }));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

beforeEach(() => vi.clearAllMocks());

function bundleFile(path = "SKILL.md", size = 7) {
  const file = new File(["content"], path.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: `bundle/${path}` });
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: vi.fn(async () => new TextEncoder().encode("content").buffer) });
  return file;
}

it.each([
  ["skill-md-required", () => [bundleFile("nested/SKILL.md")]],
  ["file-too-large", () => [bundleFile("SKILL.md", 1024 * 1024 + 1)]],
  ["revision-too-large", () => Array.from({ length: 5 }, (_, i) => bundleFile(i ? `${i}.txt` : "SKILL.md", 1024 * 1024))],
  ["too-many-files", () => Array.from({ length: 301 }, (_, i) => bundleFile(i ? `${i}.txt` : "SKILL.md"))],
] as const)("rejects %s before reading or publishing files", async (code, makeFiles) => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  const files = makeFiles();
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, files);
  expect((await screen.findByRole("alert")).textContent).toBe(`skills.errors.${code}`);
  expect(files[0]!.arrayBuffer).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
  expect(createSkill).not.toHaveBeenCalled();
});

it("clears a previously valid upload when replacement files cannot be read", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  await user.type(screen.getByLabelText(/^Skill name/), "release-notes");
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, bundleFile());
  await waitFor(() => expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false));
  const unreadable = bundleFile();
  Object.defineProperty(unreadable, "arrayBuffer", { value: async () => { throw new Error("disk error"); } });
  await user.upload(input, unreadable);
  expect((await screen.findByRole("alert")).textContent).toBe("skills.errors.file-read-failed");
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
});

it("ignores uploads finishing after the publish drawer is closed", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  let finish!: (bytes: ArrayBuffer) => void;
  const file = bundleFile();
  Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  await user.type(screen.getByLabelText(/^Skill name/), "release-notes");
  await act(async () => finish(new ArrayBuffer(0)));
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
});

it("publishes directory uploads relative to the selected bundle root", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  await user.click(screen.getByRole("button", { name: "Upload bundle" }));
  await user.type(screen.getByLabelText(/^Skill name/), "release-notes");
  const files = ["SKILL.md", "references/example.md"].map((path) => {
    const file = new File(["content"], path.split("/").at(-1)!);
    Object.defineProperty(file, "webkitRelativePath", { value: `bundle/${path}` });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("content").buffer });
    return file;
  });
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, files);
  await user.click(screen.getByRole("button", { name: "Publish" }));
  expect(createSkill).toHaveBeenCalledOnce();
  expect(createSkill.mock.calls[0][0].files.map((file: any) => file.path)).toEqual(["SKILL.md", "references/example.md"]);
});

it("defaults to upload and offers no authoring mode", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  expect(screen.queryByRole("button", { name: "Author" })).toBeNull();
  expect(screen.queryByLabelText(/^Instructions/)).toBeNull();
  expect(screen.getByRole("button", { name: "Upload bundle" }).getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector('input[type="file"]')).not.toBeNull();
});

it("marks which publish fields are required", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  const field = (label: string) =>
    screen.getByLabelText(new RegExp(`^${label}`)).closest('[data-slot="field"]') as HTMLElement;
  // The <Field> grammar: a destructive asterisk for required, the word for optional.
  expect(field("Skill name").textContent).toContain("*");
  expect(screen.queryByLabelText(/^Description/)).toBeNull();
  expect(field("Namespace").textContent).toContain("optional");
  expect(field("Namespace").textContent).not.toContain("*");
  expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
});
