import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { AgentModelField } from "../src/components/agents/AgentModelField";

// A floating base-ui popup never settles under jsdom (see the popover/menu
// stubs elsewhere), so only the floating layer is flattened; the root, input,
// list, and items stay real, which is the behaviour under test.
vi.mock("@base-ui/react/autocomplete", async (importOriginal) => {
  const { Autocomplete } = await importOriginal<typeof import("@base-ui/react/autocomplete")>();
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Autocomplete: { ...Autocomplete, Portal: Passthrough, Positioner: Passthrough, Popup: Passthrough } };
});

const RUNTIME_MODELS = ["gpt-6-luna", "gpt-5.6-terra", "o4-mini"];

interface Spies {
  onPick?: (model: string) => void;
  onSubmitCustom?: () => void;
}

function Harness({ initial, models, customEndpoint, spies }: {
  initial: string;
  models?: readonly string[];
  customEndpoint?: boolean;
  spies: Spies;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <span id="model-label">Model</span>
      <AgentModelField
        value={value}
        onChange={setValue}
        onPick={spies.onPick}
        onSubmitCustom={spies.onSubmitCustom}
        labelId="model-label"
        models={models}
        customEndpoint={customEndpoint}
      />
    </>
  );
}

function renderField(initial: string, models?: readonly string[], customEndpoint = false, spies: Spies = {}) {
  render(<Harness initial={initial} models={models} customEndpoint={customEndpoint} spies={spies} />);
  return screen.getByRole("combobox") as HTMLInputElement;
}

function optionNames() {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

it("is one typeable field that holds the pinned id", () => {
  const input = renderField("gpt-6-luna", RUNTIME_MODELS);

  expect(input.tagName).toBe("INPUT");
  expect(input.value).toBe("gpt-6-luna");
});

it("narrows the listed models to what is typed", async () => {
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS);

  await user.type(input, "gpt");

  await waitFor(() => expect(optionNames()).toEqual(["gpt-6-luna", "gpt-5.6-terra"]));
});

it("saves a listed model as soon as it is picked", async () => {
  const onPick = vi.fn();
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS, false, { onPick });

  await user.type(input, "mini");
  await user.click(await screen.findByRole("option", { name: "o4-mini" }));

  expect(onPick).toHaveBeenCalledWith("o4-mini");
  expect(input.value).toBe("o4-mini");
});

it("keeps a typed id that matches nothing, committing it on Enter", async () => {
  const onPick = vi.fn();
  const onSubmitCustom = vi.fn();
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS, false, { onPick, onSubmitCustom });

  await user.type(input, "qwen3:32b");
  expect(optionNames()).toEqual([]);
  await user.keyboard("{Enter}");

  expect(input.value).toBe("qwen3:32b");
  expect(onPick).not.toHaveBeenCalled();
  expect(onSubmitCustom).toHaveBeenCalledTimes(1);
});

it("commits a typed prefix of a listed model as typed, not the first match", async () => {
  const onPick = vi.fn();
  const onSubmitCustom = vi.fn();
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS, false, { onPick, onSubmitCustom });

  await user.type(input, "gpt-5");
  await user.keyboard("{Enter}");

  expect(input.value).toBe("gpt-5");
  expect(onPick).not.toHaveBeenCalled();
  expect(onSubmitCustom).toHaveBeenCalledTimes(1);
});

it("picks a listed model reached with the arrow keys on Enter", async () => {
  const onPick = vi.fn();
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS, false, { onPick });

  await user.type(input, "terra");
  await user.keyboard("{ArrowDown}{Enter}");

  expect(onPick).toHaveBeenCalledWith("gpt-5.6-terra");
  expect(input.value).toBe("gpt-5.6-terra");
});

it("offers no runtime ids behind a custom endpoint, only free entry", async () => {
  const user = userEvent.setup();
  const input = renderField("", RUNTIME_MODELS, true);

  await user.type(input, "gpt");

  expect(optionNames()).toEqual([]);
  expect(screen.queryByLabelText("agents_page.model_browse")).toBeNull();
  expect(input.placeholder).toBe("agents_page.model_custom_placeholder");
});

it("reads as the runtime default when nothing is pinned", () => {
  const input = renderField("", RUNTIME_MODELS);

  expect(input.value).toBe("");
  expect(input.placeholder).toBe("agents_page.model_search_placeholder");
  expect(screen.queryByLabelText("agents_page.model_reset")).toBeNull();
});
