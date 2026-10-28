import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { vi } from "vitest";
import { createContext, useContext, useState, type ReactNode } from "react";
import { TaskHoldupLine } from "../src/components/task-board/TaskHoldupLine";
import type { RelayTaskListItem } from "../src/types";

// Floating UI geometry is exercised in the browser; keep this test on the
// application's disclosure and event behavior, as the inline-field tests do.
vi.mock("@/components/ui/popover", () => {
  const Context = createContext({ open: false, toggle: () => {} });
  return {
    Popover: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return <Context.Provider value={{ open, toggle: () => setOpen(!open) }}>{children}</Context.Provider>;
    },
    PopoverTrigger: ({ children, onClick, ...props }: any) => {
      const { toggle } = useContext(Context);
      return <button {...props} onClick={(event) => { onClick?.(event); toggle(); }}>{children}</button>;
    },
    PopoverContent: ({ children }: { children: ReactNode }) => useContext(Context).open ? <div role="dialog">{children}</div> : null,
    PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    PopoverDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  };
});

it("opens the full blocker explanation without opening the task", async () => {
  const reason = "Production access is required before the migration can continue.";
  render(<TaskHoldupLine task={{ status: "blocked", blockerReason: reason } as RelayTaskListItem} />);
  fireEvent.click(screen.getByRole("button", { name: `backlog.statuses.blocked: ${reason}` }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain(reason);
});
