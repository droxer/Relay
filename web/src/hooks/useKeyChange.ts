"use client";

import { useState } from "react";

/**
 * Calls `onChange` during the render in which `key` differs from the previous
 * render's — React's "adjust state when a prop changes" pattern
 * (react.dev/learn/you-might-not-need-an-effect). Unlike an effect, the update
 * lands before the commit, so the stale state never paints and no second
 * commit follows. `onChange` may only set this component's own state; side
 * effects still belong in an effect.
 *
 * The first render is not a change unless `options.from` names the value the
 * key is treated as having held before it.
 */
export function useKeyChange<K>(
  key: K,
  onChange: (key: K, previous: K) => void,
  options?: { from: K },
): void {
  const [previous, setPrevious] = useState<K>(() => (options ? options.from : key));
  if (!Object.is(previous, key)) {
    setPrevious(key);
    onChange(key, previous);
  }
}

/**
 * Runs `reset` during the render in which a drawer or dialog opens — a mount
 * that is already open included — and again whenever `resetKey` changes while
 * it stays open (another record loaded into the same open form). Reset on
 * open, not on close: clearing as it is dismissed wipes the fields while they
 * are still on screen.
 */
export function useOnOpen(open: boolean, reset: () => void, resetKey: string = ""): void {
  useKeyChange(
    open ? resetKey : null,
    (key) => {
      if (key !== null) reset();
    },
    { from: null },
  );
}
