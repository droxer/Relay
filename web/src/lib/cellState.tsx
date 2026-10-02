"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Render-time state for TanStack column defs.
 *
 * flexRender mounts a column's header/cell function AS a component, so a
 * column def that closed over render-volatile values — `t`, a caller's inline
 * callbacks, a selection set — would unmount and remount every cell subtree
 * each time one of them changed. The column defs therefore stay stable and
 * read those values from here instead: the table's owner provides them, and a
 * header or cell reads them through `<Read>` as it renders.
 */
export function createCellState<S>(name: string) {
  const Context = createContext<S | null>(null);
  /** For a cell that is already its own component. */
  function useCellState(): S {
    const state = useContext(Context);
    if (state === null) throw new Error(`${name} cells must render inside its Provider`);
    return state;
  }
  /** For an inline column def: `cell: () => <Read>{(s) => …}</Read>`. */
  function Read({ children }: { children: (state: S) => ReactNode }) {
    return children(useCellState());
  }
  return { Provider: Context, Read, useCellState };
}
