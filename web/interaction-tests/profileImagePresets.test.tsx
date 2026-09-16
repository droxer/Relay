import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProfileImagePicker } from "../src/components/ProfileImagePicker";

// Arrow-key browsing is not covered here: base-ui's grid navigation measures
// tile positions, which are all zero in jsdom, so focus never moves. That the
// arrows only move the highlight is verified against the real build instead.

// base-ui's radio builds a PointerEvent on click, which jsdom does not ship.
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
});

function openPresets(onSelect: (url: string) => Promise<void>) {
  render(
    <ProfileImagePicker
      imageUrl={null}
      name="Builder"
      fallback={<span />}
      editable
      onUpload={vi.fn()}
      onRemove={vi.fn()}
      presets={{ kind: "agents", onSelect }}
    />,
  );
  // Synchronous on purpose: the popover's positioning keeps an async act (and
  // a waitFor, which also pretty-prints all 64 tiles on each retry) from ever
  // settling, while the synchronous open renders the tiles immediately.
  fireEvent.click(screen.getByRole("button", { name: "profile_image.choose" }));
  expect(document.querySelectorAll(".preset-avatar-option")).toHaveLength(64);
  return [...document.querySelectorAll<HTMLElement>(".preset-avatar-option")];
}

it("saves the focused preset on Enter", () => {
  const onSelect = vi.fn(async () => undefined);
  const options = openPresets(onSelect);

  options[16]!.focus();
  fireEvent.keyDown(options[16]!, { key: "Enter" });

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith("/avatars/agents/lorelei-01.svg");
});

it("saves a preset on click", () => {
  const onSelect = vi.fn(async () => undefined);
  const options = openPresets(onSelect);

  fireEvent.click(options[40]!);

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith("/avatars/agents/pixel-art-09.svg");
});
