import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AgentModelField } from "../src/components/agents/AgentModelField";

const RUNTIME_MODELS = ["gpt-6-luna", "gpt-5.6-terra"];

function renderField(value: string, models?: readonly string[], customEndpoint = false) {
  return render(
    <AgentModelField
      value={value}
      onChange={() => undefined}
      labelId="model-label"
      models={models}
      customEndpoint={customEndpoint}
    />,
  );
}

it("shows a model the runtime reports as a choice, not a custom id", () => {
  renderField("gpt-6-luna", RUNTIME_MODELS);

  expect(screen.getByRole("combobox").textContent).toContain("gpt-6-luna");
  expect(screen.queryByLabelText("agents_page.model_custom_label")).toBeNull();
});

it("treats an id the runtime does not report as a custom model", () => {
  renderField("gpt-5.1-codex", RUNTIME_MODELS);

  expect(screen.getByRole("combobox").textContent).toContain("agents_page.model_custom");
  expect((screen.getByLabelText("agents_page.model_custom_label") as HTMLInputElement).value).toBe("gpt-5.1-codex");
});

it("offers no runtime ids behind a custom endpoint", () => {
  renderField("gpt-6-luna", RUNTIME_MODELS, true);

  expect((screen.getByLabelText("agents_page.model_custom_label") as HTMLInputElement).value).toBe("gpt-6-luna");
});

it("falls back to the runtime default when nothing is pinned or reported", () => {
  renderField("", undefined);

  expect(screen.getByRole("combobox").textContent).toContain("agents_page.model_default");
  expect(screen.queryByLabelText("agents_page.model_custom_label")).toBeNull();
});
