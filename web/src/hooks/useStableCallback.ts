import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always calls the latest
 * `callback`. For handing handlers to memoized list rows: the parent may
 * rebuild its handlers every render (App declares them inline), and a new
 * function prop would defeat the row's memo on every one of those renders.
 * Only call the result from events, never during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
