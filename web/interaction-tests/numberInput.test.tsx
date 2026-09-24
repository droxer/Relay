import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Field } from "../src/components/ui/field";
import { NumberInput } from "../src/components/ui/number-input";

function LimitField({ initial = "", onChange = vi.fn() }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Field label="Computer limit" wrapper="div" htmlFor="limit-input">
      <NumberInput
        id="limit-input"
        value={value}
        min={0}
        max={3}
        placeholder="Default (3)"
        onValueChange={(next) => { setValue(next); onChange(next); }}
      />
    </Field>
  );
}

const limitInput = () => screen.getByRole("textbox", { name: "Computer limit" }) as HTMLInputElement;

it("names the input by its field label, not the step button", () => {
  render(<LimitField />);
  expect(limitInput()).toBeTruthy();
  expect(screen.getByRole("button", { name: "number_field.decrease" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "number_field.increase" })).toBeTruthy();
});

it("keeps an empty draft empty, so the placeholder default still applies", () => {
  render(<LimitField />);
  expect(limitInput().value).toBe("");
  expect(limitInput().placeholder).toBe("Default (3)");
});

it("steps from the keyboard, reports a string draft, and stops at the maximum", () => {
  const onChange = vi.fn();
  render(<LimitField initial="2" onChange={onChange} />);
  fireEvent.keyDown(limitInput(), { key: "ArrowUp" });
  expect(onChange).toHaveBeenLastCalledWith("3");
  fireEvent.keyDown(limitInput(), { key: "ArrowUp" });
  expect(limitInput().value).toBe("3");
});
