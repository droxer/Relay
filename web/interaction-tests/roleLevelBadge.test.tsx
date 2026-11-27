import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentRoleMeta, RoleLevelBadge } from "../src/components/RoleLevelBadge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

describe("RoleLevelBadge", () => {
  it("renders senior and junior badges with distinct variants and full accessible labels", () => {
    const { container } = render(
      <div>
        <RoleLevelBadge level="senior" />
        <RoleLevelBadge level="junior" />
      </div>,
    );
    const senior = container.querySelector('[data-role-level="senior"]')!;
    const junior = container.querySelector('[data-role-level="junior"]')!;
    expect(senior.getAttribute("data-variant")).toBe("warning");
    expect(senior.getAttribute("aria-label")).toBe("role_levels.senior");
    expect(senior.getAttribute("title")).toBe("role_levels.senior");
    expect(senior.textContent).toBe("role_levels.badge_senior");

    expect(junior.getAttribute("data-variant")).toBe("neutral");
    expect(junior.getAttribute("aria-label")).toBe("role_levels.junior");
    expect(junior.getAttribute("title")).toBe("role_levels.junior");
    expect(junior.textContent).toBe("role_levels.badge_junior");
  });

  it("renders full text when compact is false and renders nothing when unset", () => {
    const { container } = render(
      <div>
        <RoleLevelBadge level="senior" compact={false} />
        <RoleLevelBadge level={null} />
        <RoleLevelBadge level={undefined} />
      </div>,
    );
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
    expect(screen.getByText("role_levels.senior")).toBeTruthy();
  });
});

describe("AgentRoleMeta", () => {
  it("renders the seniority badge alongside the role name with a full tooltip", () => {
    const { container } = render(
      <AgentRoleMeta identity={{ defaultRole: "implementer", roleLevel: "senior" }} />,
    );
    const wrapper = container.querySelector(".agent-role-meta")!;
    expect(wrapper.getAttribute("title")).toBe("role_levels.senior · admin.v2.agent_role.implementer");
    expect(wrapper.querySelector('[data-role-level="senior"]')?.textContent).toBe("role_levels.badge_senior");
    expect(wrapper.querySelector(".agent-role-meta-name")?.textContent).toBe("admin.v2.agent_role.implementer");
  });

  it("omits the badge for standard agents and renders empty fallback when neither role nor level exists", () => {
    const { container, rerender } = render(
      <AgentRoleMeta identity={{ defaultRole: "tester" }} />,
    );
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
    expect(screen.getByText("admin.v2.agent_role.tester")).toBeTruthy();

    rerender(<AgentRoleMeta identity={{}} empty={<span>No role</span>} />);
    expect(screen.getByText("No role")).toBeTruthy();
  });
});
