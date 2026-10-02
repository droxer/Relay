"use client";

import { useState } from "react";
import { useKeyChange } from "./useKeyChange";

/**
 * Keeps the record a closing drawer is still showing.
 *
 * A record drawer opens over a board and is addressed by the URL, so closing
 * it clears the address immediately — while the drawer still has an exit
 * animation to play, with nothing left to render. Every board that mounts a
 * record drawer therefore mirrors the open record and releases the mirror
 * from `onClosed`; three of them had written that out by hand, and one had
 * drifted to adjusting the mirror during render instead of in an effect.
 *
 * `key` is the record's identity as a primitive — a routine run is two ids,
 * so the value it mirrors is an object that would otherwise be new on every
 * render. The value is read through the key, never depended on directly.
 */
export function useRecordDrawerMirror<T>(
  key: string | null,
  value: T | null,
): { record: T | null; release: () => void } {
  const [mirror, setMirror] = useState<T | null>(null);

  // `key` IS the value's identity, so the mirror follows the key rather than
  // the value, which is a new object on every render for object-shaped callers.
  useKeyChange(key, (next) => {
    if (next !== null) setMirror(value);
  }, { from: null });

  return {
    record: key === null ? mirror : value,
    release: () => setMirror(null),
  };
}
