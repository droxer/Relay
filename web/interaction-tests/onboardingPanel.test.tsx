import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OnboardingPanel } from "../src/components/onboarding/OnboardingPanel";
import type { OnboardingControls } from "../src/hooks/useOnboarding";
import type { OnboardingProgress } from "../src/lib/onboarding";

// The wizard frames existing flows; their own tests cover them.
vi.mock("../src/components/computer/ComputerDeviceSetup", () => ({
  ComputerDeviceSetup: () => <div data-testid="device-setup" />,
}));
vi.mock("../src/components/computer/ConnectComputerDrawer", () => ({ ConnectComputerDrawer: () => null }));
vi.mock("../src/components/agents/CreateAgentDialog", () => ({
  CreateAgentDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">create-agent</div> : null),
}));

function progress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    step: "computer",
    done: { intro: true, computer: false, agent: false, thread: false },
    completedCount: 0,
    openCards: ["tasks", "projects", "teams", "automations"],
    visible: true,
    ...overrides,
  };
}

function setup(state: OnboardingProgress) {
  const controls: OnboardingControls = {
    progress: state,
    start: vi.fn(),
    dismiss: vi.fn(),
    reopen: vi.fn(),
    closeCard: vi.fn(),
  };
  const props = {
    controls,
    userId: "user-1",
    onUseStarter: vi.fn(),
    onOpenRoute: vi.fn(),
    onOpenComputers: vi.fn(),
    onChanged: vi.fn(),
  };
  const view = render(<OnboardingPanel {...props} />);
  return { ...props, controls, view };
}

describe("OnboardingPanel", () => {
  it("starts from the intro, or lets a returning user dismiss it", () => {
    const { controls } = setup(progress({ step: "intro", done: { intro: false, computer: false, agent: false, thread: false } }));
    fireEvent.click(screen.getByRole("button", { name: "onboarding.intro.start" }));
    expect(controls.start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "onboarding.intro.skip" }));
    expect(controls.dismiss).toHaveBeenCalledOnce();
  });

  it("shows the install command while waiting for a computer", () => {
    setup(progress());
    expect(screen.getByTestId("device-setup")).toBeTruthy();
    expect(screen.getByText("onboarding.computer.waiting")).toBeTruthy();
    expect(screen.getByRole("button", { name: /onboarding.computer.label/ }).getAttribute("aria-current")).toBe("step");
  });

  it("does not offer an install the account may not use", () => {
    setup(progress({ blocked: "computer_limit" }));
    expect(screen.getByText("onboarding.computer.limit")).toBeTruthy();
    expect(screen.queryByTestId("device-setup")).toBeNull();
  });

  it("sends a connected computer with no ready runtime to its settings", () => {
    const { onOpenComputers } = setup(progress({
      blocked: "no_ready_runtime",
      computer: { id: "node-1", name: "MacBook Pro", readyRuntimes: [] },
    }));
    fireEvent.click(screen.getByRole("button", { name: "onboarding.computer.open_settings" }));
    expect(onOpenComputers).toHaveBeenCalledOnce();
  });

  it("opens the existing agent dialog for the agent step", () => {
    setup(progress({
      step: "agent",
      done: { intro: true, computer: true, agent: false, thread: false },
      completedCount: 1,
      computer: { id: "node-1", name: "MacBook Pro", readyRuntimes: ["claude"] },
    }));
    fireEvent.click(screen.getByRole("button", { name: "onboarding.agent.create" }));
    expect(screen.getByRole("dialog").textContent).toBe("create-agent");
  });

  it("drops the starter prompt into the composer", () => {
    const { onUseStarter } = setup(progress({
      step: "thread",
      computer: { id: "node-1", name: "MacBook Pro", readyRuntimes: ["claude"] },
      agent: { id: "agent-1", executorKind: "claude" },
      done: { intro: true, computer: true, agent: true, thread: false },
      completedCount: 2,
    }));
    fireEvent.click(screen.getByRole("button", { name: /onboarding.thread.starter_label/ }));
    expect(onUseStarter).toHaveBeenCalledWith("onboarding.thread.starter", {
      nodeId: "node-1", agent: { id: "agent-1", executorKind: "claude" },
    });
  });

  it("lets the person look at another step, and names what it still needs", () => {
    setup(progress());
    fireEvent.click(screen.getByRole("button", { name: /onboarding.thread.label/ }));
    expect(screen.getByRole("heading", { name: "onboarding.thread.title" })).toBeTruthy();
    expect(screen.getByText("onboarding.needs.agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "onboarding.needs.go_back" }));
    expect(screen.getByRole("heading", { name: "onboarding.agent.title" })).toBeTruthy();
  });

  it("follows real progress with an announcement and focus on the new step", () => {
    const { view, controls } = setup(progress());
    const advanced = progress({
      step: "agent",
      done: { intro: true, computer: true, agent: false, thread: false },
      completedCount: 1,
      computer: { id: "node-1", name: "MacBook Pro", readyRuntimes: ["claude"] },
    });
    view.rerender(
      <OnboardingPanel
        controls={{ ...controls, progress: advanced }}
        userId="user-1"
        onUseStarter={vi.fn()}
        onOpenRoute={vi.fn()}
        onOpenComputers={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const heading = screen.getByRole("heading", { name: "onboarding.agent.title" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("status").textContent).toBe("onboarding.announce.agent");
  });

  it("closes explore cards one at a time and finishes on Done", () => {
    const { controls, onOpenRoute } = setup(progress({
      step: "explore",
      done: { intro: true, computer: true, agent: true, thread: true },
      completedCount: 3,
    }));
    fireEvent.click(screen.getAllByRole("button", { name: "onboarding.explore.open" })[2]);
    expect(onOpenRoute).toHaveBeenCalledWith("teams");
    fireEvent.click(screen.getAllByRole("button", { name: "onboarding.explore.close" })[0]);
    expect(controls.closeCard).toHaveBeenCalledWith("tasks");
    fireEvent.click(screen.getByRole("button", { name: "onboarding.explore.done" }));
    expect(controls.dismiss).toHaveBeenCalledOnce();
  });
});
