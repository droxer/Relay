import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfileImage, ProfileImagePicker } from "../src/components/ProfileImagePicker";

it("shows the identity fallback when an image fails and retries a new image", () => {
  const { rerender } = render(<ProfileImage src="/missing.png" alt="Agent" fallback={<span>Identity</span>} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Identity")).toBeTruthy();
  rerender(<ProfileImage src="/replacement.png" alt="Agent" fallback={<span>Identity</span>} />);
  expect(screen.getByRole("img").getAttribute("src")).toBe("/replacement.png");
});

it("blocks overlapping image changes until the current upload settles", async () => {
  let finish!: () => void;
  const onUpload = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<ProfileImagePicker imageUrl="/image.png" name="Agent" fallback={<span />} editable onUpload={onUpload} onRemove={vi.fn()} />);
  const input = screen.getByLabelText("profile_image.choose") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["image"], "image.png", { type: "image/png" })] } });
  await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "profile_image.change" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "profile_image.remove" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(input, { target: { files: [new File(["other"], "other.png", { type: "image/png" })] } });
  expect(onUpload).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(input.disabled).toBe(false));
});

it("reports a failed image change and enables the controls for another attempt", async () => {
  const onRemove = vi.fn().mockRejectedValueOnce(new Error("Upload unavailable")).mockResolvedValue(undefined);
  render(<ProfileImagePicker imageUrl="/image.png" name="Agent" fallback={<span />} editable onUpload={vi.fn()} onRemove={onRemove} />);
  fireEvent.click(screen.getByRole("button", { name: "profile_image.remove" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Upload unavailable"));
  const remove = screen.getByRole("button", { name: "profile_image.remove" });
  expect(remove.hasAttribute("disabled")).toBe(false);
  fireEvent.click(remove);
  await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
