import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChoiceGroup, choiceLayout, type ChoiceOption } from "../src/components/ui/choice-group";

type Priority = "low" | "normal" | "high";
const PRIORITIES: ChoiceOption<Priority>[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

function Harness({ onChange = vi.fn(), options = PRIORITIES }: {
  onChange?: (value: Priority) => void;
  options?: ChoiceOption<Priority>[];
}) {
  const [value, setValue] = useState<Priority>("normal");
  return (
    <ChoiceGroup<Priority> aria-label="Priority" value={value} options={options}
      onValueChange={(next) => { setValue(next); onChange(next); }} />
  );
}

it("lays out up to four options as segments and more as chips", () => {
  expect(choiceLayout(2)).toBe("segments");
  expect(choiceLayout(4)).toBe("segments");
  expect(choiceLayout(5)).toBe("chips");
  expect(choiceLayout(7)).toBe("chips");
});

it("shows every option as a radio in one labelled group, the current one checked", () => {
  render(<Harness />);
  const group = screen.getByRole("radiogroup", { name: "Priority" });
  expect(group.getAttribute("data-layout")).toBe("segments");
  expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Low", "Normal", "High"]);
  expect(screen.getByRole("radio", { name: "Normal" }).getAttribute("aria-checked")).toBe("true");
});

it("reports a pressed option as the new value, and nothing for the current one", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.click(screen.getByRole("radio", { name: "Normal" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "High" }));
  expect(onChange).toHaveBeenCalledWith("high");
  expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");
});

it("keeps a disabled option on screen but never selects it", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} options={[PRIORITIES[0], PRIORITIES[1], { ...PRIORITIES[2], disabled: true }]} />);
  const high = screen.getByRole("radio", { name: "High" });
  expect(high.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(high);
  expect(onChange).not.toHaveBeenCalled();
});
