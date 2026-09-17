import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TopEmployees } from "../src/components/admin/dashboard/TopEmployees";

const ID = "3f2a9c1e-8b4d-5e6f-9a0b-1c2d3e4f5a6b";

it("draws each employee's initials from their name, never from the id", () => {
  const { container } = render(
    <TopEmployees
      employees={[{ id: ID, handle: "fei", displayName: "Fei He" }]}
      nodes={[]}
      ranked={[{ employeeId: ID, sessionCount: 30 }]}
    />,
  );
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("FH");
});

it("names an employee missing from the roster without printing the raw id", () => {
  const { container } = render(<TopEmployees employees={[]} nodes={[]} ranked={[{ employeeId: ID, sessionCount: 3 }]} />);
  expect(screen.queryByText(ID)).toBeNull();
  expect(container.textContent).not.toContain(ID);
});
