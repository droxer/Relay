import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DialogProvider, useDialogs } from "../src/components/ui/DialogProvider";
import { useTranscriptPin } from "../src/hooks/useTranscriptPin";

it("allows typing a complete replacement in a rename prompt", async () => {
  function Trigger() {
    const { prompt } = useDialogs();
    return <button onClick={() => void prompt({ title: "Rename", defaultValue: "old" })}>Open</button>;
  }
  render(<DialogProvider><Trigger /></DialogProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByText("Open"));
  screen.getByRole("textbox").focus();
  await user.keyboard("new name");
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("new name");
});

it("rebinds transcript observation when the same session's DOM remounts", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
  function Harness() {
    const [visible, setVisible] = useState(true);
    const pin = useTranscriptPin(1, "same-session");
    return <><button onClick={() => setVisible(!visible)}>Toggle</button>{visible && <div ref={pin.ref}><div data-testid="content" /></div>}</>;
  }
  render(<Harness />);
  const first = screen.getByTestId("content");
  expect(observe).toHaveBeenCalledWith(first);
  fireEvent.click(screen.getByText("Toggle"));
  expect(disconnect).toHaveBeenCalled();
  fireEvent.click(screen.getByText("Toggle"));
  expect(observe).toHaveBeenLastCalledWith(screen.getByTestId("content"));
  vi.unstubAllGlobals();
});
