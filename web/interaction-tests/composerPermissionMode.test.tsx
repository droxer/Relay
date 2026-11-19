import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ComposerPermissionMode } from "../src/components/composer/ComposerPermissionMode";

it("chooses a tool permission mode without submitting the Chat Input", async () => {
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const onChange = vi.fn();
  const { rerender } = render(
    <form onSubmit={onSubmit}>
      <ComposerPermissionMode mode="ask" onChange={onChange} />
    </form>,
  );
  const trigger = screen.getByRole("combobox", { name: "composer.permission_mode" });
  expect(trigger.textContent).toContain("composer.permission_ask");
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: "composer.permission_yolo_option" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("yolo");
  expect(onSubmit).not.toHaveBeenCalled();
  rerender(<form onSubmit={onSubmit}><ComposerPermissionMode mode="yolo" pending onChange={onChange} /></form>);
  expect(trigger.textContent).toContain("composer.permission_yolo");
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
});
