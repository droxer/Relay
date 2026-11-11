import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkRoutePage } from "../src/components/WorkRoutePage";

vi.mock("../src/components/RoutinesPage", () => ({ RoutinesPage: () => <div>Automation list</div> }));
vi.mock("../src/components/TasksWorkspace", () => ({ TasksWorkspace: () => <div>Task list</div> }));

it.each([["routine", "Automation list"], ["backlog", "Task list"]] as const)("renders the global %s list without a Computer", async (route, label) => {
  const props = { route, user: { userId: "u" }, projects: [], tasks: [], visibleNodes: [], onOpenThread: vi.fn(), onOpenAgent: vi.fn() } as unknown as Parameters<typeof WorkRoutePage>[0];
  render(<Suspense><WorkRoutePage {...props} /></Suspense>);
  expect(await screen.findByText(label)).toBeTruthy();
});
