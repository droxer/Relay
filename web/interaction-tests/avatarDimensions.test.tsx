import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { PresetAvatarGrid } from "../src/components/PresetAvatarGrid";
import { ProfileImage } from "../src/components/ProfileImagePicker";

it("reserves a square box for an uploaded profile image before it decodes", () => {
  const { container } = render(<ProfileImage src="/profile-images/a.png" alt="" fallback={<span />} />);
  const img = container.querySelector("img");
  expect(img?.getAttribute("width")).toBe("64");
  expect(img?.getAttribute("height")).toBe("64");
});

it("reserves a square box for every preset avatar tile", () => {
  const { container } = render(<PresetAvatarGrid kind="teams" value={null} onChange={() => {}} />);
  const images = [...container.querySelectorAll(".preset-avatar-option img")];
  expect(images.length).toBeGreaterThan(0);
  for (const img of images) {
    expect(img.getAttribute("width")).toBe("32");
    expect(img.getAttribute("height")).toBe("32");
  }
});
