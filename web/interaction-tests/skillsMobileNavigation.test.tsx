import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
import { MobileTopbarSlotContext } from "../src/components/MobileTopbarSlot";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { CurrentUser } from "../src/types";

const { getSkill } = vi.hoisted(() => ({ getSkill: vi.fn() }));
vi.mock("../src/api", async (load) => ({
  ...await load<Record<string, unknown>>(),
  getSkill,
  listSkills: async () => ({ skills: [{
    id: "skill-1", displayName: "Release notes", visibility: "private", grantedAgentCount: 0,
  }] }),
}));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

function MobileSkills() {
  const [lead, setLead] = useState<HTMLDivElement | null>(null);
  return <>
    <div ref={setLead} />
    <MobileTopbarSlotContext.Provider value={{ lead, actions: null, title: null }}>
      <DialogProvider><SkillsPage currentUser={{ userId: "user-1" } as CurrentUser} /></DialogProvider>
    </MobileTopbarSlotContext.Provider>
  </>;
}

it.each(["loading", "error"] as const)("returns to the mobile skill library while details are %s", async (state) => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  getSkill.mockImplementation(() => state === "loading"
    ? new Promise(() => {})
    : Promise.reject(new Error("not-found")));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const user = userEvent.setup();
  const { container } = render(<QueryClientProvider client={client}><MobileSkills /></QueryClientProvider>);
  const page = container.querySelector(".skills-page")!;
  expect(page.getAttribute("data-phone-pane")).toBe("list");
  expect(screen.queryByRole("button", { name: "skills.title" })).toBeNull();
  await user.click(await screen.findByRole("button", { name: /Release notes/ }));
  await screen.findByRole(state === "loading" ? "status" : "alert");
  expect(page.getAttribute("data-phone-pane")).toBe("detail");

  await user.click(screen.getByRole("button", { name: "skills.title" }));

  expect(page.getAttribute("data-phone-pane")).toBe("list");
  expect(screen.queryByRole("button", { name: "skills.title" })).toBeNull();
  client.clear();
});
