import { fireEvent, render, screen } from "@testing-library/react";
import { useId, useState } from "react";
import { expect, it, vi } from "vitest";
import { Field } from "../src/components/ui/field";
import { DatePicker } from "../src/components/ui/date-picker";

function DueField({ initial = "", onChange = vi.fn(), ...rest }: {
  initial?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  readOnly?: boolean;
  min?: string;
}) {
  const [value, setValue] = useState(initial);
  const labelId = useId();
  return (
    <form aria-label="task">
      <Field label="Due" wrapper="div" labelId={labelId}>
        <DatePicker labelId={labelId} name="due" value={value} onValueChange={(next) => { setValue(next); onChange(next); }} {...rest} />
      </Field>
    </form>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Due / });

it("names the trigger by its field label and the chosen day", () => {
  render(<DueField initial="2026-07-19" />);
  expect(trigger().getAttribute("aria-labelledby")?.split(" ")).toHaveLength(2);
  expect(screen.getByRole("button", { name: /^Due .*2026/ })).toBeTruthy();
});

it("shows a placeholder when empty", () => {
  render(<DueField />);
  expect(trigger().textContent).toContain("date_picker.placeholder");
});

it("clears an optional date", () => {
  const onChange = vi.fn();
  render(<DueField initial="2026-07-19" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "date_picker.clear" }));
  expect(onChange).toHaveBeenLastCalledWith("");
});

it("keeps a required date required for form submission, and offers no clear", () => {
  const { container } = render(<DueField required />);
  const native = container.querySelector<HTMLInputElement>('input[name="due"]')!;
  expect(native.required).toBe(true);
  expect(native.checkValidity()).toBe(false);
  expect(screen.queryByRole("button", { name: "date_picker.clear" })).toBeNull();
});

it("does not open a read-only date", () => {
  render(<DueField initial="2026-07-19" readOnly />);
  fireEvent.click(trigger());
  expect(screen.queryByRole("grid")).toBeNull();
  expect(trigger().getAttribute("aria-disabled")).toBe("true");
});
